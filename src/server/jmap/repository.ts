import { withDatabase } from "../db";
import type { JmapContext } from "./types";
import { listJmapMailboxes } from "./access";
import type {
	INativeJmapMessagesResult,
	INativeJmapAttachmentsResult,
} from "../../queries.gen";
export function messageRow(row: INativeJmapMessagesResult) {
	return {
		id: row.id,
		userId: row.user_id,
		mailboxId: row.mailbox_id,
		folderId: row.folder_id,
		direction: row.direction,
		providerMessageId: row.provider_message_id,
		fromAddr: row.from_addr,
		toAddr: row.to_addr,
		ccAddr: row.cc_addr,
		bccAddr: row.bcc_addr,
		replyTo: row.reply_to,
		subject: row.subject,
		snippet: row.snippet,
		textBody: row.text_body,
		htmlBody: row.html_body,
		rawR2Key: row.raw_r2_key,
		status: row.status,
		read: !!row.read,
		starred: !!row.starred,
		snoozedUntil:
			row.snoozed_until == null ? null : new Date(row.snoozed_until * 1000),
		threadId: row.thread_id,
		inReplyTo: row.in_reply_to,
		references: row.references_header,
		createdAt: new Date(row.created_at * 1000),
		draftRevision: row.draft_revision,
	};
}
export type MessageRow = ReturnType<typeof messageRow>;
function attachmentRow(row: INativeJmapAttachmentsResult) {
	return {
		id: row.id,
		messageId: row.message_id,
		filename: row.filename,
		contentType: row.content_type,
		size: row.size,
		disposition: row.disposition,
		contentId: row.content_id,
		r2Key: row.r2_key,
	};
}
export type AttachmentRow = ReturnType<typeof attachmentRow>;
export async function scopeIds(ctx: JmapContext) {
	return (await listJmapMailboxes(ctx)).map((row) => row.id);
}
export async function loadMessages(
	ctx: JmapContext,
	ids: string[],
): Promise<MessageRow[]> {
	if (!ids.length) return [];
	const scope = await scopeIds(ctx),
		fallback = !scope.length && !ctx.auth.mailboxIds;
	const rows = await withDatabase(
		(sql) =>
			sql.NativeJmapMessages`SELECT * FROM messages WHERE id IN(SELECT value FROM json_each(${JSON.stringify(ids)})) AND (mailbox_id IN(SELECT value FROM json_each(${JSON.stringify(scope)})) OR (${fallback ? 1 : 0}=1 AND user_id=${ctx.auth.userId})) AND (status!='draft' OR user_id=${ctx.auth.userId}) ORDER BY rowid`,
	);
	return rows.map(messageRow);
}
export async function jmapAttachments(_ctx: JmapContext, ids: string[]) {
	const result = new Map<string, AttachmentRow[]>();
	if (!ids.length) return result;
	const rows = await withDatabase(
		(sql) =>
			sql.NativeJmapAttachments`SELECT * FROM message_attachments WHERE message_id IN(SELECT value FROM json_each(${JSON.stringify(ids)})) AND trashed_at IS NULL ORDER BY rowid`,
	);
	for (const raw of rows) {
		const row = attachmentRow(raw),
			items = result.get(row.messageId) ?? [];
		items.push(row);
		result.set(row.messageId, items);
	}
	return result;
}
