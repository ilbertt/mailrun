import { enqueueWebhooks } from "../webhooks/repository";
import { wakeWebhookDispatcher } from "../webhooks/dispatcher";
import { deleteUnreferencedObjects } from "../storage";
import { upsertContact } from "./contacts";
import { buildSnippet } from "../../lib/email/parse";
import {
	parseMessageIdList,
	formatMessageIdHeader,
	normalizeMessageId,
} from "../../lib/email/threading";
import { z } from "zod";
import { sendSchema, userSchema, type User } from "../../shared/contracts";
import { withDatabase, id, seconds } from "../db";
import { outboundConfig, sendThroughProvider } from "./provider";
import type { CloudflareFetch } from "../cloudflare/client";
import {
	draftLock,
	getDraft,
	saveDraft,
	senderAddress,
	formattedSender,
} from "./drafts";
import { deliveryPayloadSchema } from "../../shared/mail-contracts";
import { prepareAttachments } from "./attachment-send";

export async function sendMessage(
	user: User,
	input: z.infer<typeof sendSchema>,
) {
	const data = sendSchema.parse(input);
	const draft = await saveDraft(user, {
		...data,
		html: data.html ?? "",
		cc: data.cc ?? "",
		bcc: data.bcc ?? "",
	});
	return sendDraft(user, draft.id, draft.draft_revision);
}
export async function sendDraft(
	user: User,
	draftId: string,
	revision: number,
	request: CloudflareFetch = fetch,
) {
	const result = await draftLock(draftId, async () => {
		const draft = await getDraft(user, draftId);
		if (!draft.mailbox_id) throw new Error("Select a mailbox before sending");
		if (draft.draft_revision !== revision)
			throw new Error("Draft changed. Save the latest version before sending.");
		await senderAddress(user, draft.mailbox_id, draft.from_addr);
		await outboundConfig(draft.from_addr);
		const payload = deliveryPayloadSchema.parse({
			from: draft.from_addr,
			to: draft.to_addr,
			cc: draft.cc_addr ?? "",
			bcc: draft.bcc_addr ?? "",
			subject: draft.subject ?? "",
			text: draft.text_body ?? "",
			html: draft.html_body ?? "",
			inReplyTo: draft.in_reply_to,
			references: draft.references_header,
			threadId: draft.thread_id,
			returnToDraft: true,
		});
		if (
			!payload.text?.trim() &&
			!payload.html?.trim() &&
			!draft.attachments.length
		)
			throw new Error("Enter a message or attach a file");
		const due = Math.max(seconds(), draft.draft_scheduled_at ?? seconds());
		const scheduledAt = due > seconds() ? due : null;
		const jobId = id("job");
		await withDatabase((sql) =>
			sql.begin(async (sql) => {
				const changed =
					await sql.QueueDraft`UPDATE messages SET status='queued',created_at=${seconds()} WHERE id=${draftId} AND user_id=${user.id} AND status='draft' AND draft_revision=${revision} RETURNING id`;
				if (!changed.length) throw new Error("Draft is no longer editable");
				await sql.InsertOutboundJob`INSERT INTO outbound_jobs (id,user_id,message_id,status,payload,created_at,updated_at,scheduled_at) VALUES (${jobId},${user.id},${draftId},'queued',${JSON.stringify(payload)},${seconds()},${seconds()},${scheduledAt})`;
			}),
		);
		return { jobId, due };
	});
	if (result.due <= seconds()) await deliverJob(result.jobId, request);
	return { messageId: draftId, scheduled: result.due > seconds() };
}
export async function deliverJob(
	jobId: string,
	request: CloudflareFetch = fetch,
) {
	const [job] = await withDatabase(
		(sql) => sql.ClaimOutbound`
		UPDATE outbound_jobs SET status='sending',updated_at=${seconds()}
		WHERE id=${jobId} AND status='queued' AND (scheduled_at IS NULL OR scheduled_at<=${seconds()})
		AND EXISTS (SELECT 1 FROM messages WHERE messages.id=outbound_jobs.message_id AND messages.status='queued')
		RETURNING id,user_id,message_id,payload`,
	);
	if (!job) return;
	let restoreDraft = false;
	let submittedDraftId: string | undefined;
	let approvalId: string | undefined;
	try {
		const payload = deliveryPayloadSchema.parse(JSON.parse(job.payload));
		restoreDraft = !!payload.returnToDraft;
		submittedDraftId = payload.submittedDraftId;
		approvalId = payload.approvalId;
		const [account] = await withDatabase(
			(sql) =>
				sql.SendingAccount`SELECT id,name,email,role,is_primary_admin FROM users WHERE id=${job.user_id} AND disabled=0`,
		);
		const [message] = await withDatabase(
			(sql) =>
				sql.SendingMessage`SELECT mailbox_id FROM messages WHERE id=${job.message_id}`,
		);
		if (!account || !message?.mailbox_id)
			throw new Error("Sender account or mailbox is no longer available");
		const user = userSchema.parse({
			...account,
			isPrimaryAdmin: !!account.is_primary_admin,
		});
		const from = await formattedSender(user, message.mailbox_id, payload.from);
		const provider = await outboundConfig(payload.from);
		// Cloudflare owns Message-ID; only threading headers are supplied.
		const headers: Record<string, string> = {};
		if (payload.autoReplyMailboxId && payload.autoReplyRecipient) {
			headers["Auto-Submitted"] = "auto-replied";
			headers["X-Auto-Response-Suppress"] = "All";
		}
		const parent = normalizeMessageId(payload.inReplyTo);
		if (parent) {
			const value = formatMessageIdHeader([parent]);
			if (Buffer.byteLength(value) <= 2048) headers["In-Reply-To"] = value;
		}
		const references = parseMessageIdList(payload.references);
		while (
			references.length > 1 &&
			Buffer.byteLength(formatMessageIdHeader(references)) > 2048
		)
			references.splice(1, 1);
		if (
			references.length &&
			Buffer.byteLength(formatMessageIdHeader(references)) <= 2048
		)
			headers.References = formatMessageIdHeader(references);
		const prepared = await prepareAttachments(
			job.message_id ?? "",
			{
				subject: payload.subject,
				text: payload.text,
				html: payload.html,
				headers,
			},
			provider.provider,
		);
		const result = await sendThroughProvider(
			provider,
			{
				from,
				to: payload.to,
				cc: payload.cc,
				bcc: payload.bcc,
				subject: payload.subject,
				headers,
				...prepared,
			},
			request,
			jobId,
		);
		const submittedObjects = await withDatabase((sql) =>
			sql.begin(async (sql) => {
				if (payload.autoReplyMailboxId && payload.autoReplyRecipient)
					await sql.NativeRecordAutoReply`INSERT INTO auto_reply_deliveries (id,mailbox_id,recipient,sent_at) VALUES (${id("arp")},${payload.autoReplyMailboxId},${payload.autoReplyRecipient},${seconds()}) ON CONFLICT(mailbox_id,recipient) DO UPDATE SET sent_at=excluded.sent_at`;
				await sql.CompleteOutbound`UPDATE outbound_jobs SET status='sent',error=NULL,updated_at=${seconds()} WHERE id=${job.id}`;
				await sql.CompleteSentMessage`UPDATE messages SET status='sent',from_addr=${from},snippet=${buildSnippet(prepared.text ?? null, prepared.html ?? null)},provider_message_id=${result.messageId},thread_id=coalesce(thread_id,${result.messageId.replace(/^<|>$/g, "")}),text_body=${prepared.text ?? null},html_body=${prepared.html ?? null} WHERE id=${job.message_id}`;
				await enqueueWebhooks(sql, user.id, "message.outbound", {
					messageId: job.message_id,
					providerMessageId: result.messageId,
					to: payload.to.join(", "),
					cc: payload.cc?.length ? payload.cc.join(", ") : undefined,
				});
				if (payload.approvalId)
					await sql.NativeCompleteAgentApproval`UPDATE agent_send_approvals SET status='sent',message_id=${job.message_id} WHERE id=${payload.approvalId} AND user_id=${job.user_id} AND message_id=${job.message_id} AND status IN('claimed','unknown')`;
				if (payload.submittedDraftId) {
					const [draft] =
						await sql.NativeCompleteSubmittedDraft`SELECT raw_r2_key FROM messages WHERE id=${payload.submittedDraftId} AND user_id=${job.user_id} AND status='queued'`;
					if (draft) {
						if (payload.retainSubmittedDraft) {
							await sql.NativeTrashApprovedDraft`UPDATE messages SET status='trash',trashed_at=${seconds()} WHERE id=${payload.submittedDraftId} AND user_id=${job.user_id} AND status='queued'`;
							return [] as string[];
						}
						const files =
							await sql.NativeSubmittedDraftFiles`SELECT r2_key FROM message_attachments WHERE message_id=${payload.submittedDraftId}`;
						await sql.NativeDeleteSubmittedDraft`DELETE FROM messages WHERE id=${payload.submittedDraftId} AND user_id=${job.user_id} AND status='queued'`;
						return [
							...files.map((file) => file.r2_key),
							...(draft.raw_r2_key ? [draft.raw_r2_key] : []),
						];
					}
				}
				return [] as string[];
			}),
		);
		await deleteUnreferencedObjects(submittedObjects).catch((error) =>
			console.warn("Submitted draft file cleanup failed", error),
		);
		wakeWebhookDispatcher();
		for (const recipient of [
			...payload.to,
			...(payload.cc ?? []),
			...(payload.bcc ?? []),
		])
			await upsertContact(user.id, recipient, "outbound").catch((error) =>
				console.error("Sent contact update failed", error),
			);
	} catch (error) {
		await withDatabase((sql) =>
			sql.begin(async (sql) => {
				await sql.FailOutbound`UPDATE outbound_jobs SET status='failed',error=${error instanceof Error ? error.message : "Sending failed"},updated_at=${seconds()} WHERE id=${job.id}`;
				if (approvalId)
					await sql.NativeFailAgentApproval`UPDATE agent_send_approvals SET status='unknown' WHERE id=${approvalId} AND user_id=${job.user_id} AND message_id=${job.message_id} AND status='claimed'`;
				if (submittedDraftId)
					await sql.NativeRestoreSubmittedDraft`UPDATE messages SET status='draft' WHERE id=${submittedDraftId} AND user_id=${job.user_id} AND status='queued'`;
				await sql.FailSentMessage`UPDATE messages SET status=${restoreDraft ? "draft" : "failed"} WHERE id=${job.message_id}`;
				if (job.user_id)
					await enqueueWebhooks(sql, job.user_id, "message.failed", {
						messageId: job.message_id,
						error: error instanceof Error ? error.message : "Sending failed",
					});
			}),
		);
		wakeWebhookDispatcher();
		throw error;
	}
}
