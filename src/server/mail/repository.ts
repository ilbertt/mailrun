import {
	resolveMailboxDisplayName,
	resolveMailboxAvatarKey,
} from "../../lib/profile/identity-utils";
import { withDatabase, seconds, type AppSQL } from "../db";
import {
	type User,
	type ListInput,
	type Folder,
	messageActionSchema,
} from "../../shared/contracts";
import { z } from "zod";
import { mailboxAccess, MailboxAccessError } from "./access";
export class MessageReadError extends Error {
	constructor() {
		super("Message not found");
		this.name = "MessageReadError";
	}
}

export async function listMailboxes(user: User) {
	return withDatabase(async (sql) => {
		const rows = await sql.ListMailboxes`
 /* @notNull id */
 /* @notNull user_id */
 /* @notNull domain_owner */
 SELECT m.id,m.local_part,m.display_name,d.hostname,m.user_id,m.domain_id,d.user_id AS domain_owner,m.use_all_domains,m.signature,m.type,m.avatar_key,m.auto_reply_enabled,m.auto_reply_subject,m.auto_reply_body,u.email AS owner_email,u.name AS owner_name,u.avatar_key AS owner_avatar,
 CASE WHEN m.user_id=${user.id} THEN 'full_access' ELSE (SELECT permission FROM mailbox_access WHERE mailbox_id=m.id AND user_id=${user.id} LIMIT 1) END AS permission
 FROM mailboxes m JOIN domains d ON d.id=m.domain_id JOIN users u ON u.id=m.user_id WHERE m.disabled=0 AND (m.user_id=${user.id} OR (m.type='shared' AND EXISTS(SELECT 1 FROM license_settings l WHERE l.id='default' AND l.plan='team' AND l.state='active') AND EXISTS(SELECT 1 FROM mailbox_access a WHERE a.mailbox_id=m.id AND a.user_id=${user.id}))) ORDER BY m.created_at,m.id`;
		if (!rows.length) return [];
		const owners = JSON.stringify([
				...new Set(rows.map((row) => row.domain_owner)),
			]),
			ids = JSON.stringify(rows.map((row) => row.id));
		const [domains, aliases, occupied] = await Promise.all([
			sql.MailboxSenderDomains`SELECT id,hostname,user_id FROM domains WHERE status='active' AND user_id IN(SELECT value FROM json_each(${owners})) ORDER BY hostname,id`,
			sql.MailboxSenderAliases`SELECT a.mailbox_id,a.local_part,d.hostname FROM mailbox_aliases a JOIN domains d ON d.id=a.domain_id WHERE a.mailbox_id IN(SELECT value FROM json_each(${ids})) ORDER BY a.created_at,a.id`,
			sql.MailboxSenderOccupied`/* @notNull local_part */ SELECT b.id AS mailbox_id,b.local_part,b.domain_id FROM mailboxes b JOIN domains d ON d.id=b.domain_id WHERE d.user_id IN(SELECT value FROM json_each(${owners})) UNION ALL SELECT a.mailbox_id,a.local_part,a.domain_id FROM mailbox_aliases a JOIN domains d ON d.id=a.domain_id WHERE d.user_id IN(SELECT value FROM json_each(${owners}))`,
		]);
		const normalize = (value: string) =>
			(value.split("+")[0] ?? "").replaceAll(".", "").toLowerCase();
		return rows.map((row) => {
			const senders = new Set([
				`${row.local_part}@${row.hostname}`,
				...aliases
					.filter((alias) => alias.mailbox_id === row.id)
					.map((alias) => `${alias.local_part}@${alias.hostname}`),
			]);
			if (row.use_all_domains)
				for (const domain of domains) {
					if (domain.user_id !== row.domain_owner) continue;
					if (
						occupied.some(
							(address) =>
								address.domain_id === domain.id &&
								address.mailbox_id !== row.id &&
								normalize(address.local_part) === normalize(row.local_part),
						)
					)
						continue;
					senders.add(`${row.local_part}@${domain.hostname}`);
				}
			const identity = {
				localPart: row.local_part,
				hostname: row.hostname,
				type: row.type,
				displayName: row.display_name,
				avatarKey: row.avatar_key,
			};
			const { owner_email, owner_name, owner_avatar, ...mailbox } = row;
			return {
				...mailbox,
				isPrimary:
					`${row.local_part}@${row.hostname}`.toLowerCase() ===
					user.email.toLowerCase(),
				display_name: resolveMailboxDisplayName(
					identity,
					owner_email,
					owner_name,
				),
				avatar_key: resolveMailboxAvatarKey(
					identity,
					owner_email,
					owner_avatar,
				),
				permission: z
					.enum(["full_access", "send_as", "send_on_behalf", "read_only"])
					.parse(row.permission),
				senderAddresses: [...senders],
			};
		});
	});
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
			/* @notNull user_id */
			SELECT m.id,m.mailbox_id,m.thread_id,m.user_id,m.raw_r2_key FROM messages m JOIN mailboxes b ON b.id=m.mailbox_id
			JOIN domains d ON d.id=b.domain_id WHERE m.id=${messageId} AND b.disabled=0
			AND (m.status!='draft' OR m.user_id=${user.id})
			AND (b.user_id=${user.id}
				OR (b.type='shared' AND EXISTS(SELECT 1 FROM license_settings l WHERE l.id='default' AND l.plan='team' AND l.state='active') AND EXISTS (SELECT 1 FROM mailbox_access a WHERE a.mailbox_id=b.id AND a.user_id=${user.id} AND a.permission IN('read_only','send_on_behalf','send_as','full_access')))) LIMIT 1`;
	if (!message) throw new MessageReadError();
	return message;
}
export async function messageReference(user: User, messageId: string) {
	return withDatabase((sql) => authorizeMessage(sql, user, messageId));
}
export async function getThreadWithRecord(user: User, messageId: string) {
	return withDatabase(async (sql) => {
		const message = await authorizeMessage(sql, user, messageId);
		const rows = await sql.ThreadMessages`
			SELECT id,user_id,folder_id,direction,bcc_addr,snippet,snoozed_until,spam_score,spam_verdict,spam_signals,spam_analyzed_at,spam_analysis_error,from_addr,to_addr,cc_addr,reply_to,subject,text_body,html_body,created_at,read,starred,status,provider_message_id,in_reply_to,references_header,thread_id,mailbox_id,trashed_at
			FROM messages WHERE mailbox_id=${message.mailbox_id}
			AND ((${message.thread_id || null} IS NULL AND id=${message.id}) OR (${message.thread_id || null} IS NOT NULL AND thread_id=${message.thread_id} AND status NOT IN ('draft','trash')))
			ORDER BY created_at ASC,id ASC LIMIT 200`;

		const attachments = await sql.ThreadAttachments`
 SELECT a.id,a.message_id,a.filename,a.size,a.content_id,a.content_type,a.disposition FROM message_attachments a WHERE a.message_id IN(SELECT value FROM json_each(${JSON.stringify(rows.map((row) => row.id))})) AND a.trashed_at IS NULL`;

		return {
			record: message,
			messages: rows.map((row) => ({
				...row,
				attachments: attachments.filter(
					(attachment) => attachment.message_id === row.id,
				),
			})),
		};
	});
}

export async function getThread(user: User, messageId: string) {
	return (await getThreadWithRecord(user, messageId)).messages;
}

export async function messageFile(
	user: User,
	messageId: string,
	attachmentId?: string,
) {
	return withDatabase(async (sql) => {
		if (attachmentId) {
			const [message] =
				await sql.SourceAttachmentMessage`SELECT id,user_id,mailbox_id,status FROM messages WHERE id=${messageId}`;
			if (
				!message ||
				(message.status === "draft" && message.user_id !== user.id)
			)
				throw new MessageReadError();
			if (message.mailbox_id) {
				try {
					await mailboxAccess(user, message.mailbox_id, "read", sql);
				} catch (error) {
					if (error instanceof MailboxAccessError) throw new MessageReadError();
					throw error;
				}
			} else if (message.user_id !== user.id) throw new MessageReadError();
		} else await authorizeMessage(sql, user, messageId);
		if (attachmentId) {
			const [attachment] = await sql.DownloadAttachment`
				SELECT r2_key,filename,content_type,disposition,size FROM message_attachments
				WHERE id=${attachmentId} AND message_id=${messageId} AND trashed_at IS NULL LIMIT 1`;
			if (!attachment) throw new MessageReadError();
			return {
				key: attachment.r2_key,
				size: attachment.size,
				filename: attachment.filename,
				contentType: attachment.content_type,
				disposition: attachment.disposition,
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
			AND (b.user_id=${user.id} OR (b.type='shared' AND EXISTS(SELECT 1 FROM license_settings l WHERE l.id='default' AND l.plan='team' AND l.state='active') AND EXISTS (
				SELECT 1 FROM mailbox_access a WHERE a.mailbox_id=b.id AND a.user_id=${user.id} AND a.permission='full_access'
			)))
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
