import { enqueueAutoDraft } from "../agent/jobs";
import { wakeAgentDispatcher } from "../agent/dispatcher";
import { enqueueWebhooks } from "../webhooks/repository";
import { wakeWebhookDispatcher } from "../webhooks/dispatcher";
import { notifyNewMessage } from "../realtime";
import { queueAutoReply } from "./auto-reply";
import { deliverJob } from "./send";
import { parsePostalMime, buildSnippet } from "../../lib/email/parse";
import { normalizeMessageId } from "../../lib/email/threading";
import { selectThreadLookupIds } from "../../lib/email/thread-lookup";
import { analyzeSpam } from "../../lib/spam/engine";
import type { SpamAnalysisResult } from "../../lib/spam/types";
import { getReputationKeys } from "../../lib/spam/analyzers/reputation";
import { observeReputation } from "./spam-feedback";
import { upsertContact } from "./contacts";
import { licenseEntitlements } from "../licenses";
import { getEmailAddress } from "../../lib/email/address";
import PostalMime from "postal-mime";
import { withDatabase, id, seconds } from "../db";
import { LocalStorage } from "../storage";
import { getInstallation } from "../cloudflare/installation";
import { verifyRelay } from "../../shared/relay-signature";
import { relayDecisionSchema } from "../../shared/contracts";
import { resolveRouting, inboxDestination } from "./routing";
import { z } from "zod";
import {
	formatPostalAddress,
	formatPostalAddressList,
} from "../../lib/email/address";

export async function readLimitedBody(request: Request, limit: number) {
	if (Number(request.headers.get("content-length") ?? 0) > limit)
		throw new Error("Message too large");
	const chunks: Uint8Array[] = [];
	let length = 0;
	const reader = request.body?.getReader();
	if (reader) {
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				length += chunk.value.length;
				if (length > limit) {
					await reader.cancel();
					throw new Error("Message too large");
				}
				chunks.push(chunk.value);
			}
		} finally {
			reader.releaseLock();
		}
	}
	const bytes = new Uint8Array(length);
	let position = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, position);
		position += chunk.length;
	}
	return bytes;
}

export async function inbound(request: Request): Promise<Response> {
	const installation = await getInstallation();
	if (!installation)
		return new Response("Email not configured", { status: 503 });
	let raw: Uint8Array<ArrayBuffer>;
	try {
		raw = await readLimitedBody(request, 25 * 1024 * 1024);
	} catch (error) {
		if (error instanceof Error && error.message === "Message too large")
			return new Response(error.message, { status: 413 });
		throw error;
	}
	const from = request.headers.get("x-mailrun-from") ?? "";
	const to = request.headers.get("x-mailrun-to") ?? "";
	const phase = z
		.enum(["receive", "forwarded", "forward-failed"])
		.safeParse(request.headers.get("x-mailrun-phase") ?? "receive");
	if (!phase.success)
		return new Response("Invalid relay phase", { status: 400 });
	const signatureFrom =
		phase.data === "receive" ? from : `${phase.data}\n${from}`;
	const valid = await verifyRelay(
		installation.relay_secret,
		request.headers.get("x-mailrun-timestamp") ?? "",
		signatureFrom,
		to,
		raw,
		request.headers.get("x-mailrun-signature") ?? "",
	);
	if (!valid) return new Response("Invalid signature", { status: 401 });
	const result = await storeInbound(from, to, raw, {
		phase: phase.data,
		legacy: request.headers.get("x-mailrun-relay") !== "2",
	});
	return Response.json(relayDecisionSchema.parse(result));
}

export async function storeInbound(
	from: string,
	to: string,
	raw: Uint8Array<ArrayBuffer>,
	options: {
		phase?: "receive" | "forwarded" | "forward-failed";
		legacy?: boolean;
		provider?: boolean;
		headers?: Record<string, string>;
		parsed?: Awaited<ReturnType<typeof PostalMime.parse>>;
	} = {},
) {
	to = to.toLowerCase();
	const parsed = options.parsed ?? (await PostalMime.parse(raw)),
		message = parsePostalMime(parsed);
	const headers = {
		...Object.fromEntries(
			parsed.headers.map((header) => [header.key.toLowerCase(), header.value]),
		),
		...Object.fromEntries(
			Object.entries(options.headers ?? {}).map(([name, value]) => [
				name.toLowerCase(),
				value,
			]),
		),
	};
	if (message.attachments.length > 10)
		return {
			action: "reject" as const,
			reason:
				"Message rejected: more than 10 attachments. Send fewer files or a download link.",
		};
	if (
		message.attachments.some(
			(attachment) => attachment.content.byteLength > 25_000_000,
		)
	)
		return {
			action: "reject" as const,
			reason:
				"Message rejected: an attachment exceeds 25 MB. Send a download link instead.",
		};
	if (
		message.attachments.reduce(
			(total, attachment) => total + attachment.content.byteLength,
			0,
		) > 25_000_000
	)
		return {
			action: "reject" as const,
			reason:
				"Message rejected: attachments exceed 25 MB in total. Send a download link instead.",
		};
	const decision = await resolveRouting(
		to,
		from,
		!options.phase || options.phase === "receive",
		{
			subject: parsed.subject ?? "",
			content: [parsed.text, parsed.html].filter(Boolean).join("\n"),
		},
	);
	if (!decision) {
		if (options.provider) return { action: "accepted" as const };
		return { action: "reject" as const, reason: "Unknown recipient" };
	}
	if (decision.action === "reject") return decision;
	// Provider webhooks cannot forward the original SMTP delivery. As in the
	// source provider intake/queue, accept without a stored message when a
	// forward has no local copy, or when routing has no destination mailbox.
	if (
		options.provider &&
		((decision.action === "forward" && !decision.keepCopy) || !decision.mailbox)
	)
		return { action: "accepted" as const };
	const mailbox = decision.mailbox;
	const forwarded = parsed.headers.some(
		(header) =>
			header.key.toLowerCase() === "x-mailflare-forwarded" &&
			header.value === "1",
	);
	const [account] = mailbox
		? await withDatabase(
				(sql) =>
					sql.InboundForwarding`SELECT forwarding_email,spam_protection_enabled FROM users WHERE id=${mailbox.user_id}`,
			)
		: [];
	const forwardTo = forwarded
		? null
		: decision.action === "forward"
			? decision.forwardTo
			: (await licenseEntitlements()).canForwardEmail
				? account?.forwarding_email
				: null;
	if (
		forwardTo &&
		forwardTo.toLowerCase() !== to &&
		(options.phase ?? "receive") === "receive" &&
		!options.legacy &&
		!options.provider
	) {
		return {
			action: "forward" as const,
			forwardTo,
			keepCopy: decision.action !== "forward" || decision.keepCopy,
		};
	}
	if (!mailbox) {
		if (options.legacy && forwardTo)
			return { action: "forward" as const, forwardTo, keepCopy: false };
		throw new Error("Forward failed and no fallback mailbox is configured");
	}
	const digest = new Bun.CryptoHasher("sha256")
		.update(to)
		.update("\n")
		.update(raw)
		.digest("hex");
	const messageId = `msg_${digest}`;
	const rawKey = `inbound/${digest}.eml`;
	const exists = await withDatabase(
		(sql) => sql.InboundExists`SELECT id FROM messages WHERE id=${messageId}`,
	);
	if (exists.length) return { action: "store" as const, messageId };

	const storage = new LocalStorage();
	await storage.put(rawKey, raw);
	const attachments = await Promise.all(
		message.attachments.map(async (attachment, index) => {
			const key = `attachments/${digest}/${index}`;
			await storage.put(key, attachment.content);
			return {
				key,
				filename: attachment.filename,
				contentType: attachment.type,
				size: attachment.content.byteLength,
				contentId: attachment.contentId ?? null,
				disposition: attachment.disposition ?? "attachment",
			};
		}),
	);
	const fromAddr = message.fromAddr ?? from,
		toAddr = message.toAddr ?? to,
		snippet = buildSnippet(message.text, message.html);
	const destination = await inboxDestination(mailbox.id, {
		to,
		from: fromAddr,
		subject: message.subject ?? "",
		content: [message.text, message.html, snippet].filter(Boolean).join(" "),
	});
	let analysis: SpamAnalysisResult | null = null,
		analysisError: string | null = null;
	if (account?.spam_protection_enabled !== 0) {
		try {
			analysis = await withDatabase((sql) =>
				analyzeSpam(sql, {
					mailboxId: mailbox.id,
					userId: mailbox.user_id,
					envelopeFrom: from,
					headers,
					message,
				}),
			);
		} catch (error) {
			analysisError =
				error instanceof Error
					? error.message.slice(0, 300)
					: "Spam analysis failed";
		}
	}
	if (destination.status === "spam" && analysis)
		analysis = {
			score: 100,
			verdict: "spam",
			signals: [
				{
					id: "mailbox_rule_spam",
					score: 100,
					reason: "A mailbox rule marked this message as spam",
				},
			],
			fingerprint: analysis.fingerprint,
		};
	const status =
			destination.status === "received" && analysis?.verdict === "spam"
				? "spam"
				: destination.status,
		folderId = status === "spam" ? null : destination.folderId;
	const variants = selectThreadLookupIds(
		message.inReplyTo,
		message.references,
	).flatMap((value) => [value, `<${value}>`]);
	const sender = getEmailAddress(fromAddr).toLowerCase();
	const [own] = await withDatabase(
		(sql) =>
			sql.NativeInboundOwnAddress`SELECT b.id FROM mailboxes b JOIN domains d ON d.id=b.domain_id WHERE b.user_id=${mailbox.user_id} AND lower(b.local_part||'@'||d.hostname)=${sender} UNION ALL SELECT a.id FROM mailbox_aliases a JOIN domains d ON d.id=a.domain_id JOIN mailboxes b ON b.id=a.mailbox_id WHERE b.user_id=${mailbox.user_id} AND lower(a.local_part||'@'||d.hostname)=${sender} LIMIT 1`,
	);
	const [parent] = variants.length
		? await withDatabase(
				(sql) =>
					sql.NativeInboundThread`SELECT thread_id,provider_message_id FROM messages WHERE mailbox_id=${mailbox.id} AND provider_message_id IN(SELECT value FROM json_each(${JSON.stringify(variants)})) ORDER BY created_at,id LIMIT 1`,
			)
		: [];
	const threadId =
		parent?.thread_id ??
		normalizeMessageId(parent?.provider_message_id) ??
		normalizeMessageId(message.messageId) ??
		id("thr");
	const inserted = await withDatabase((sql) =>
		sql.begin(async (sql) => {
			const inserted =
				await sql.InsertInbound`INSERT INTO messages (id,user_id,mailbox_id,direction,provider_message_id,from_addr,to_addr,cc_addr,reply_to,references_header,subject,snippet,text_body,html_body,raw_r2_key,status,folder_id,trashed_at,thread_id,in_reply_to,read,spam_score,spam_verdict,spam_signals,spam_analyzed_at,spam_analysis_error,created_at) VALUES (${messageId},${mailbox.user_id},${mailbox.id},'inbound',${message.messageId},${fromAddr},${toAddr},${message.ccAddr},${message.replyTo},${message.references.length ? message.references.join(" ") : null},${message.subject},${snippet},${message.text},${message.html},${rawKey},${status},${folderId},${status === "trash" ? seconds() : null},${threadId},${message.inReplyTo},${own ? 1 : 0},${analysis?.score ?? null},${analysis?.verdict ?? null},${analysis ? JSON.stringify(analysis.signals) : null},${analysis ? seconds() : null},${analysisError},${seconds()}) ON CONFLICT(id) DO NOTHING RETURNING id`;
			if (!inserted.length) return false;
			for (const attachment of attachments)
				await sql.InsertInboundAttachment`INSERT INTO message_attachments (id,message_id,filename,content_type,size,disposition,content_id,r2_key,created_at) VALUES (${id("att")},${messageId},${attachment.filename},${attachment.contentType},${attachment.size},${attachment.disposition},${attachment.contentId},${attachment.key},${seconds()})`;
			if (analysis)
				await observeReputation(
					sql,
					mailbox.id,
					getReputationKeys(message, analysis.fingerprint),
				);
			await enqueueWebhooks(sql, mailbox.user_id, "message.inbound", {
				messageId,
				from: fromAddr,
				to,
				cc: message.ccAddr ?? undefined,
				subject: message.subject,
				threadId,
				spamScore: analysis?.score,
				spamVerdict: analysis?.verdict,
			});
			await enqueueAutoDraft(sql, {
				mailboxId: mailbox.id,
				sourceMessageId: messageId,
				ownerUserId: mailbox.user_id,
				sender: fromAddr,
				headers,
				status,
				folderId,
				spamVerdict: analysis?.verdict,
				spamAnalysisError: analysisError,
			});
			return true;
		}),
	);
	if (inserted) {
		wakeAgentDispatcher();
		wakeWebhookDispatcher();
		const contact = await upsertContact(mailbox.user_id, fromAddr, "inbound");
		if (status !== "spam")
			await notifyNewMessage({
				type: "new_message",
				messageId,
				mailboxId: mailbox.id,
				from: fromAddr,
				fromName: contact?.display_name ?? null,
				subject: message.subject,
			});
		if (status === "received") {
			const jobId = await queueAutoReply({
				mailboxId: mailbox.id,
				userId: mailbox.user_id,
				deliveredAddress: to,
				fromAddress: fromAddr,
				incomingMessageId: message.messageId,
				threadId,
				headers,
			});
			if (jobId)
				await deliverJob(jobId).catch((error) =>
					console.error("Auto-reply delivery failed", error),
				);
		}
	}
	return options.legacy && forwardTo
		? { action: "forward" as const, forwardTo, keepCopy: true }
		: { action: "store" as const, messageId };
}
