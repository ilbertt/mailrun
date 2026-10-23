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
	} = {},
) {
	to = to.toLowerCase();
	const parsed = await PostalMime.parse(raw);
	if (parsed.attachments.length > 10)
		return {
			action: "reject" as const,
			reason: "Message exceeds the 10-attachment receiving limit",
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
	if (!decision)
		return { action: "reject" as const, reason: "Unknown recipient" };
	if (decision.action === "reject") return decision;
	const mailbox = decision.mailbox;
	const forwarded = parsed.headers.some(
		(header) =>
			header.key.toLowerCase() === "x-mailflare-forwarded" &&
			header.value === "1",
	);
	const [account] = mailbox
		? await withDatabase(
				(sql) =>
					sql.InboundForwarding`SELECT forwarding_email FROM users WHERE id=${mailbox.user_id}`,
			)
		: [];
	const forwardTo = forwarded
		? null
		: decision.action === "forward"
			? decision.forwardTo
			: account?.forwarding_email;
	if (
		forwardTo &&
		forwardTo.toLowerCase() !== to &&
		(options.phase ?? "receive") === "receive" &&
		!options.legacy
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
		parsed.attachments.map(async (attachment, index) => {
			const key = `attachments/${digest}/${index}`;
			const bytes =
				typeof attachment.content === "string"
					? new TextEncoder().encode(attachment.content)
					: new Uint8Array(attachment.content);
			await storage.put(key, bytes);
			return {
				key,
				filename: attachment.filename ?? "attachment",
				contentType: attachment.mimeType,
				size: bytes.length,
				contentId: attachment.contentId ?? null,
				disposition: attachment.disposition ?? "attachment",
			};
		}),
	);
	const reference = parsed.inReplyTo?.replace(/^<|>$/g, "") ?? "";
	const destination = await inboxDestination(mailbox.id, {
		to,
		from,
		subject: parsed.subject ?? "",
		content: [parsed.text, parsed.html].filter(Boolean).join("\n"),
	});
	const parent = await withDatabase(
		async (sql) =>
			(
				await sql.InboundParent`
			SELECT thread_id,id FROM messages WHERE mailbox_id=${mailbox.id}
			AND (provider_message_id=${reference} OR provider_message_id=${`<${reference}>`}) LIMIT 1`
			)[0],
	);
	// The transaction begins with a write. Concurrent duplicate deliveries cannot
	// get stuck upgrading two deferred read transactions to write transactions.
	await withDatabase((sql) =>
		sql.begin(async (sql) => {
			const inserted = await sql.InsertInbound`
			INSERT INTO messages (id,user_id,mailbox_id,direction,provider_message_id,from_addr,to_addr,cc_addr,reply_to,references_header,subject,snippet,text_body,html_body,raw_r2_key,status,folder_id,trashed_at,thread_id,in_reply_to,created_at)
			VALUES (${messageId},${mailbox.user_id},${mailbox.id},'inbound',${parsed.messageId ?? null},${formatPostalAddress(parsed.from, from) ?? from},${formatPostalAddressList(parsed.to, to) ?? to},${formatPostalAddressList(parsed.cc, null)},${formatPostalAddressList(parsed.replyTo, null)},${parsed.references ?? null},${parsed.subject ?? ""},${(parsed.text ?? "").slice(0, 200)},${parsed.text ?? null},${parsed.html ?? null},${rawKey},${destination.status},${destination.folderId},${destination.status === "trash" ? seconds() : null},${parent?.thread_id ?? parent?.id ?? messageId},${reference || null},${seconds()})
			ON CONFLICT(id) DO NOTHING RETURNING id`;
			if (!inserted.length) return;
			for (const attachment of attachments) {
				await sql.InsertInboundAttachment`
				INSERT INTO message_attachments (id,message_id,filename,content_type,size,disposition,content_id,r2_key,created_at)
				VALUES (${id("att")},${messageId},${attachment.filename},${attachment.contentType},${attachment.size},${attachment.disposition},${attachment.contentId},${attachment.key},${seconds()})`;
			}
		}),
	);
	return options.legacy && forwardTo
		? { action: "forward" as const, forwardTo, keepCopy: true }
		: { action: "store" as const, messageId };
}
