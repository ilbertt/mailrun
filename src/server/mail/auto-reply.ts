import { withDatabase, id, seconds } from "../db";
import { resolveRouting } from "./routing";
import { getEmailAddress } from "../../lib/email/address";
import { normalizeMessageId } from "../../lib/email/threading";
import { buildSnippet } from "../../lib/email/parse";
import { deliveryPayloadSchema } from "../../shared/mail-contracts";
export async function queueAutoReply(input: {
	mailboxId: string;
	userId: string;
	deliveredAddress: string;
	fromAddress: string;
	incomingMessageId: string | null;
	threadId: string;
	headers: Record<string, string>;
}) {
	const recipient = getEmailAddress(input.fromAddress).toLowerCase(),
		delivered = getEmailAddress(input.deliveredAddress).toLowerCase();
	const local = recipient.slice(0, recipient.indexOf("@"));
	if (
		!recipient.includes("@") ||
		recipient === delivered ||
		/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)$/i.test(local)
	)
		return null;
	const auto = input.headers["auto-submitted"]?.toLowerCase();
	if (
		(auto && auto !== "no") ||
		/^(bulk|junk|list)$/i.test(input.headers.precedence ?? "") ||
		[
			"list-id",
			"x-autoreply",
			"x-autorespond",
			"x-auto-response-suppress",
		].some((key) => !!input.headers[key])
	)
		return null;
	const target = await resolveRouting(recipient, "", false);
	if (
		target &&
		target.action !== "reject" &&
		target.mailbox?.id === input.mailboxId
	)
		return null;
	return withDatabase((sql) =>
		sql.begin(async (tx) => {
			const [mailbox] =
				await tx.NativeAutoReplySettings`SELECT auto_reply_enabled,auto_reply_subject,auto_reply_body FROM mailboxes WHERE id=${input.mailboxId} AND user_id=${input.userId} AND disabled=0`;
			if (!mailbox?.auto_reply_enabled || !mailbox.auto_reply_body.trim())
				return null;
			const [recent] =
				await tx.NativeRecentAutoReply`SELECT id FROM auto_reply_deliveries WHERE mailbox_id=${input.mailboxId} AND recipient=${recipient} AND sent_at>=${seconds() - 86400} LIMIT 1`;
			if (recent) return null;
			const [pending] =
				await tx.NativePendingAutoReply`SELECT id FROM outbound_jobs WHERE status IN ('queued','sending') AND json_extract(payload,'$.autoReplyMailboxId')=${input.mailboxId} AND json_extract(payload,'$.autoReplyRecipient')=${recipient} LIMIT 1`;
			if (pending) return null;
			const messageId = id("msg"),
				jobId = id("job"),
				subject = mailbox.auto_reply_subject.trim() || "Out of office",
				text = mailbox.auto_reply_body.trim();
			const payload = deliveryPayloadSchema.parse({
				from: delivered,
				to: recipient,
				subject,
				text,
				inReplyTo: normalizeMessageId(input.incomingMessageId),
				references: input.incomingMessageId,
				threadId: input.threadId,
				autoReplyMailboxId: input.mailboxId,
				autoReplyRecipient: recipient,
			});
			await tx.NativeAutoReplyMessage`INSERT INTO messages (id,user_id,mailbox_id,direction,from_addr,to_addr,subject,text_body,snippet,status,read,in_reply_to,references_header,thread_id,created_at) VALUES (${messageId},${input.userId},${input.mailboxId},'outbound',${delivered},${recipient},${subject},${text},${buildSnippet(text, null)},'queued',1,${payload.inReplyTo ?? null},${payload.references ?? null},${input.threadId},${seconds()})`;
			await tx.NativeAutoReplyJob`INSERT INTO outbound_jobs (id,user_id,message_id,status,payload,created_at,updated_at,scheduled_at) VALUES (${jobId},${input.userId},${messageId},'queued',${JSON.stringify(payload)},${seconds()},${seconds()},${seconds()})`;
			return jobId;
		}),
	);
}
