import { withDatabase, seconds, type AppSQL } from "../db";
import {
	type User,
	type ListInput,
	type Folder,
	messageActionSchema,
} from "../../shared/contracts";
import { z } from "zod";

export async function listMailboxes(user: User) {
	const rows = await withDatabase(
		(sql) => sql.ListMailboxes`
		/* @notNull id */
		/* @notNull user_id */
		SELECT m.id,m.local_part,m.display_name,d.hostname,m.user_id,m.domain_id,m.use_all_domains,m.signature,
		CASE WHEN m.user_id=${user.id} OR d.user_id=${user.id} THEN 'full_access' ELSE (SELECT permission FROM mailbox_access WHERE mailbox_id=m.id AND user_id=${user.id} LIMIT 1) END AS permission
		FROM mailboxes m JOIN domains d ON d.id=m.domain_id
		WHERE m.disabled=0 AND (m.user_id=${user.id} OR d.user_id=${user.id}
			OR EXISTS (SELECT 1 FROM mailbox_access a WHERE a.mailbox_id=m.id AND a.user_id=${user.id}))
		ORDER BY m.created_at,m.id`,
	);
	return rows.map((row) => ({
		...row,
		permission: z
			.enum(["full_access", "send_as", "send_on_behalf", "read_only"])
			.parse(row.permission),
	}));
}
export async function mailCounts(user: User, mailboxId: string) {
	await requireMailbox(user, mailboxId);
	const [counts] = await withDatabase(
		(sql) => sql.MailboxCounts`
		SELECT sum(CASE WHEN status='received' AND folder_id IS NULL AND read=0 AND (snoozed_until IS NULL OR snoozed_until<=${seconds()}) THEN 1 ELSE 0 END) AS inbox_unread,
		sum(CASE WHEN status='draft' AND user_id=${user.id} THEN 1 ELSE 0 END) AS drafts FROM messages WHERE mailbox_id=${mailboxId}`,
	);
	return {
		inboxUnread: Number(counts?.inbox_unread ?? 0),
		drafts: Number(counts?.drafts ?? 0),
	};
}
export async function requireMailbox(user: User, mailboxId: string) {
	const mailbox = (await listMailboxes(user)).find(
		(mailbox) => mailbox.id === mailboxId,
	);
	if (!mailbox) throw new Error("Mailbox not found");
	return mailbox;
}
function statusFor(folder: Folder) {
	return {
		inbox: "received",
		sent: "sent",
		drafts: "draft",
		archived: "archived",
		spam: "spam",
		trash: "trash",
		scheduled: "queued",
		starred: "",
		snoozed: "received",
	}[folder];
}
export function ftsQuery(query: string) {
	return query
		.split(/\s+/)
		.filter(Boolean)
		.map((term) => `"${term.replaceAll('"', '""')}"`)
		.join(" AND ");
}
export async function listMessages(user: User, input: ListInput) {
	const mailboxes = await listMailboxes(user);
	const mailboxId = input.mailboxId ?? mailboxes[0]?.id;
	if (!mailboxId) return { messages: [], hasMore: false };
	if (!mailboxes.some((mailbox) => mailbox.id === mailboxId))
		throw new Error("Mailbox not found");
	if (input.folder === "inbox" && !input.q && !input.folderId) {
		const rows = await withDatabase(
			(sql) => sql.InboxMessages`
			SELECT id,from_addr,to_addr,subject,snippet,created_at,read,starred,status,thread_id,direction
			FROM messages WHERE mailbox_id=${mailboxId} AND status='received' AND folder_id IS NULL
			AND (snoozed_until IS NULL OR snoozed_until<=${seconds()})
			ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET ${input.offset}`,
		);
		return { messages: rows.slice(0, 50), hasMore: rows.length > 50 };
	}
	const status = statusFor(input.folder);
	const match = input.q ? ftsQuery(input.q) : '""';
	const rows = await withDatabase(
		(sql) => sql.ListMessages`
		SELECT id,from_addr,to_addr,subject,snippet,created_at,read,starred,status,thread_id,direction
		FROM messages WHERE mailbox_id=${mailboxId}
		AND (${input.folderId ?? null} IS NULL OR folder_id=${input.folderId ?? null})
		AND (${status}='' OR status=${status})
		AND (status!='draft' OR user_id=${user.id})
		AND (${input.folder}!='starred' OR (starred=1 AND status NOT IN ('trash','spam')))
		AND (${input.folder}!='inbox' OR ${input.folderId ?? null} IS NOT NULL OR (folder_id IS NULL AND (snoozed_until IS NULL OR snoozed_until<=${seconds()})))
		AND (${input.folder}!='snoozed' OR snoozed_until>${seconds()})
		AND (${input.q}='' OR rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${match}))
		ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET ${input.offset}`,
	);
	return { messages: rows.slice(0, 50), hasMore: rows.length > 50 };
}
async function authorizeMessage(sql: AppSQL, user: User, messageId: string) {
	const [message] = await sql.AuthorizedMessage`
			/* @notNull id */
			/* @notNull mailbox_id */
			SELECT m.id,m.mailbox_id,m.thread_id FROM messages m JOIN mailboxes b ON b.id=m.mailbox_id
			JOIN domains d ON d.id=b.domain_id WHERE m.id=${messageId} AND b.disabled=0
			AND (m.status!='draft' OR m.user_id=${user.id})
			AND (b.user_id=${user.id} OR d.user_id=${user.id}
				OR EXISTS (SELECT 1 FROM mailbox_access a WHERE a.mailbox_id=b.id AND a.user_id=${user.id})) LIMIT 1`;
	if (!message) throw new Error("Message not found");
	return message;
}
export async function getThread(user: User, messageId: string) {
	return withDatabase(async (sql) => {
		const message = await authorizeMessage(sql, user, messageId);
		const rows = await sql.ThreadMessages`
			SELECT id,from_addr,to_addr,cc_addr,reply_to,subject,text_body,html_body,created_at,read,starred,status,provider_message_id,in_reply_to,references_header,thread_id,mailbox_id
			FROM messages WHERE mailbox_id=${message.mailbox_id}
			AND (status!='draft' OR user_id=${user.id})
			AND (id=${message.id} OR (${message.thread_id} IS NOT NULL AND thread_id=${message.thread_id}))
			ORDER BY created_at DESC,id DESC LIMIT 100`;
		const attachments = await sql.ThreadAttachments`
			/* @notNull id */
			SELECT a.id,a.message_id,a.filename,a.size,a.content_id,a.content_type FROM message_attachments a JOIN messages m ON m.id=a.message_id
			WHERE m.mailbox_id=${message.mailbox_id} AND a.trashed_at IS NULL
			AND (m.status!='draft' OR m.user_id=${user.id})
			AND (m.id=${message.id} OR (${message.thread_id} IS NOT NULL AND m.thread_id=${message.thread_id}))`;
		return rows.reverse().map((row) => ({
			...row,
			attachments: attachments.filter(
				(attachment) => attachment.message_id === row.id,
			),
		}));
	});
}

export async function messageFile(
	user: User,
	messageId: string,
	attachmentId?: string,
) {
	return withDatabase(async (sql) => {
		await authorizeMessage(sql, user, messageId);
		if (attachmentId) {
			const [attachment] = await sql.DownloadAttachment`
				SELECT r2_key,filename,content_type FROM message_attachments
				WHERE id=${attachmentId} AND message_id=${messageId} AND trashed_at IS NULL LIMIT 1`;
			if (!attachment) throw new Error("Attachment not found");
			return {
				key: attachment.r2_key,
				filename: attachment.filename,
				contentType: attachment.content_type,
			};
		}
		const [message] =
			await sql.DownloadOriginal`SELECT raw_r2_key FROM messages WHERE id=${messageId} LIMIT 1`;
		if (!message?.raw_r2_key) throw new Error("Original message not found");
		return {
			key: message.raw_r2_key,
			filename: `${messageId}.eml`,
			contentType: "message/rfc822",
		};
	});
}
export async function changeMessage(
	user: User,
	input: z.infer<typeof messageActionSchema>,
) {
	const data = messageActionSchema.parse(input);
	const rows = await withDatabase(
		(sql) => sql.ChangeMessage`
		UPDATE messages SET
			read=CASE WHEN ${data.action}='read' THEN 1 WHEN ${data.action}='unread' THEN 0 ELSE read END,
			starred=CASE WHEN ${data.action}='star' THEN 1 WHEN ${data.action}='unstar' THEN 0 ELSE starred END,
			status=CASE WHEN ${data.action}='archive' THEN 'archived' WHEN ${data.action}='trash' THEN 'trash' WHEN ${data.action}='inbox' THEN 'received' ELSE status END,
			trashed_at=CASE WHEN ${data.action}='trash' THEN ${seconds()} WHEN ${data.action}='inbox' THEN NULL ELSE trashed_at END
		WHERE id=${data.id} AND mailbox_id IN (
			SELECT b.id FROM mailboxes b JOIN domains d ON d.id=b.domain_id WHERE b.disabled=0
			AND (b.user_id=${user.id} OR d.user_id=${user.id} OR EXISTS (
				SELECT 1 FROM mailbox_access a WHERE a.mailbox_id=b.id AND a.user_id=${user.id} AND a.permission='full_access'
			))
		) AND (status!='draft' OR user_id=${user.id}) RETURNING id`,
	);
	if (!rows.length)
		throw new Error("Message not found or modification not permitted");
	if (data.action === "trash")
		await withDatabase(
			(sql) =>
				sql.CancelTrashedSend`UPDATE outbound_jobs SET status='cancelled',updated_at=${seconds()} WHERE message_id=${data.id} AND status='queued'`,
		);
	return { id: data.id };
}
