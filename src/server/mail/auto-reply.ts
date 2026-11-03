import { withDatabase, id, seconds } from "../db";
import { resolveRouting } from "./routing";
import { normalizeEmailAddress } from "../../lib/email/address";
import { sourceSendSender } from "./session-send";
import { upsertContact } from "./contacts";
import { userSchema } from "../../shared/contracts";
import { buildSnippet } from "../../lib/email/parse";
import { deliveryPayloadSchema } from "../../shared/mail-contracts";
export async function queueAutoReply(input: {
	mailboxId: string;
	userId: string;
	deliveredAddress: string;
	fromAddress: string;
	incomingMessageId?: string | null;
	threadId?: string;
	headers?: Record<string, string>;
}) {
	const recipient = normalizeEmailAddress(input.fromAddress),
		delivered = normalizeEmailAddress(input.deliveredAddress);
	const local = recipient.slice(0, recipient.indexOf("@"));
	if (
		!recipient.includes("@") ||
		recipient === delivered ||
		/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)$/i.test(local)
	)
		return null;
	const header = (name: string) =>
		Object.entries(input.headers ?? {})
			.find(([key]) => key.toLowerCase() === name)?.[1]
			?.trim() ?? "";
	const auto = header("auto-submitted").toLowerCase();
	if (
		(auto && auto !== "no") ||
		/^(bulk|junk|list)$/i.test(header("precedence")) ||
		[
			"list-id",
			"x-autoreply",
			"x-autorespond",
			"x-auto-response-suppress",
		].some((name) => !!header(name))
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
			await tx.NativeAutoReplyWriteFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
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
			const [account] =
				await tx.NativeAutoReplyAccount`SELECT id,name,email,role,is_primary_admin FROM users WHERE id=${input.userId} AND disabled=0`;
			if (!account) throw new Error("Sender account not found");
			const user = userSchema.parse({
				...account,
				isPrimaryAdmin: !!account.is_primary_admin,
			});
			const from = await sourceSendSender(user, input.mailboxId, delivered, tx);
			const headers: Record<string, string> = {
				"Auto-Submitted": "auto-replied",
				"X-Auto-Response-Suppress": "All",
			};
			if (input.incomingMessageId) {
				headers["In-Reply-To"] = input.incomingMessageId;
				headers.References = input.incomingMessageId;
			}
			const payload = {
				userId: input.userId,
				mailboxId: input.mailboxId,
				from,
				to: [recipient],
				cc: [],
				bcc: [],
				subject,
				text,
				headers,
				attachments: [],
				autoReplyMailboxId: input.mailboxId,
				autoReplyRecipient: recipient,
			};
			deliveryPayloadSchema.parse(payload);
			await upsertContact(
				input.userId,
				recipient,
				"outbound",
				input.mailboxId,
				tx,
			);
			await tx.NativeAutoReplyMessage`INSERT INTO messages (id,user_id,mailbox_id,direction,from_addr,to_addr,subject,text_body,snippet,status,read,created_at) VALUES (${messageId},${input.userId},${input.mailboxId},'outbound',${from},${recipient},${subject},${text},${buildSnippet(text, null)},'queued',1,${seconds()})`;
			await tx.NativeAutoReplyJob`INSERT INTO outbound_jobs (id,user_id,message_id,status,payload,created_at,updated_at,scheduled_at) VALUES (${jobId},${input.userId},${messageId},'queued',${JSON.stringify(payload)},${seconds()},${seconds()},NULL)`;
			return jobId;
		}),
	);
}
