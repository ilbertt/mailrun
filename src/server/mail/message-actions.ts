import { spamFeedback } from "./spam-feedback";
import { z } from "zod";
import { withDatabase, id, seconds, type AppSQL } from "../db";
import { mailboxAccess, MailboxAccessError } from "./access";
import type { User } from "../../shared/contracts";
import { deleteUnreferencedObjects } from "../storage";

export const bulkActionSchema = z.object({
	messageIds: z.array(z.string().min(1)).min(1),
	action: z.enum([
		"archive",
		"trash",
		"spam",
		"read",
		"unread",
		"inbox",
		"folder",
		"delete",
	]),
	folderId: z.string().max(200).optional(),
});
export async function messageRecord(
	user: User,
	messageId: string,
	level: "read" | "send" | "manage" = "read",
) {
	const [message] = await withDatabase(
		(sql) =>
			sql.SourceMessageRecord`SELECT * FROM messages WHERE id=${messageId}`,
	);
	if (
		!message?.mailbox_id ||
		(message.status === "draft" && message.user_id !== user.id)
	)
		throw new Response("Message not found", { status: 404 });
	await mailboxAccess(user, message.mailbox_id, level);
	return message;
}
export async function audit(
	sql: AppSQL,
	user: User,
	mailboxId: string | null,
	messageId: string | null,
	action: string,
	metadata: Record<string, unknown> | null = null,
) {
	await sql.MailAudit`INSERT INTO audit_logs (id,actor_user_id,mailbox_id,message_id,action,metadata,created_at) VALUES (${id("audit")},${user.id},${mailboxId},${messageId},${action},${metadata === null ? null : JSON.stringify(metadata)},${seconds()})`;
}
async function actionMessage(
	sql: AppSQL,
	user: User,
	messageId: string,
	level: "read" | "manage",
) {
	const [message] =
		await sql.NativeActionMessage`SELECT m.id,m.mailbox_id,m.status,m.direction FROM messages m JOIN mailboxes b ON b.id=m.mailbox_id WHERE m.id=${messageId} AND b.disabled=0 AND (m.status!='draft' OR m.user_id=${user.id}) AND (b.user_id=${user.id} OR (b.type='shared' AND EXISTS(SELECT 1 FROM license_settings WHERE id='default' AND plan='team' AND state='active') AND EXISTS(SELECT 1 FROM mailbox_access a WHERE a.mailbox_id=b.id AND a.user_id=${user.id} AND a.permission IN('read_only','send_on_behalf','send_as','full_access') AND (${level}='read' OR a.permission='full_access')))) LIMIT 1`;
	if (!message) throw new Response("Message not found", { status: 404 });
	return message;
}
export async function markRead(user: User, messageId: string) {
	await withDatabase((sql) =>
		sql.begin(async (sql) => {
			const message = await actionMessage(sql, user, messageId, "read");
			await sql.NativeMarkMessageRead`UPDATE messages SET read=1 WHERE id=${messageId}`;
			await audit(sql, user, message.mailbox_id, messageId, "email.read");
		}),
	);
	return { success: true };
}
export const messageStatusSchema = z.enum([
	"received",
	"sent",
	"draft",
	"trash",
	"spam",
]);
export async function updateMessageStatus(
	user: User,
	messageId: string,
	status: z.infer<typeof messageStatusSchema>,
) {
	return withDatabase((sql) =>
		sql.begin(async (sql) => {
			const [message] =
				await sql.NativeStatusMessage`SELECT m.id,m.mailbox_id,m.status FROM messages m JOIN mailboxes b ON b.id=m.mailbox_id WHERE m.id=${messageId} AND b.disabled=0 AND (m.status!='draft' OR m.user_id=${user.id}) AND (b.user_id=${user.id} OR (b.type='shared' AND EXISTS(SELECT 1 FROM license_settings WHERE id='default' AND plan='team' AND state='active') AND EXISTS(SELECT 1 FROM mailbox_access WHERE mailbox_id=b.id AND user_id=${user.id} AND permission='full_access'))) LIMIT 1`;
			if (!message) return false;
			const [sending] =
				await sql.NativeStatusSendingGuard`SELECT id FROM outbound_jobs WHERE status IN('queued','sending') AND ((message_id=${messageId} AND (status='sending' OR json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.submittedDraftId') IS NOT NULL)) OR json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.submittedDraftId')=${messageId}) LIMIT 1`;
			if (sending)
				throw new Response("A message is being sent. Try again shortly.", {
					status: 409,
				});
			if (
				status === "spam" ||
				(status === "received" && message.status === "spam")
			)
				return spamFeedback(
					sql,
					user,
					messageId,
					status === "spam" ? "spam" : "ham",
					false,
				);
			await sql.NativeUpdateMessageStatus`UPDATE messages SET status=${status} WHERE id=${messageId}`;
			await audit(sql, user, message.mailbox_id, messageId, "email.delete", {
				status,
			});
			return true;
		}),
	);
}
export async function bulkAction(
	user: User,
	input: z.input<typeof bulkActionSchema>,
	source: "bulk" | "empty" | "retention" = "bulk",
) {
	const data = bulkActionSchema.parse(input),
		ids = [...new Set(data.messageIds)];
	if (data.action === "folder" && !data.folderId)
		throw new Response("Folder is required", { status: 400 });
	const folder =
		data.action === "folder"
			? await withDatabase(
					async (sql) =>
						(
							await sql.BulkTargetFolder`SELECT id,mailbox_id FROM folders WHERE id=${data.folderId ?? ""}`
						)[0],
				)
			: undefined;
	if (data.action === "folder") {
		if (!folder) throw new Response("Folder not found", { status: 404 });
		try {
			await mailboxAccess(user, folder.mailbox_id, "manage");
		} catch (error) {
			if (error instanceof MailboxAccessError)
				throw new Response("Folder not found", { status: 404 });
			throw error;
		}
	}
	const selected = await withDatabase(
		(sql) => sql.BulkAuthorizedMessages`
 /* @notNull id */
 /* @notNull status */
 SELECT m.id,m.mailbox_id,m.status,m.raw_r2_key,m.direction FROM messages m JOIN mailboxes b ON b.id=m.mailbox_id JOIN domains d ON d.id=b.domain_id
 WHERE m.id IN (SELECT value FROM json_each(${JSON.stringify(ids)})) AND b.disabled=0 AND (m.status!='draft' OR m.user_id=${user.id})
 AND (b.user_id=${user.id} OR (b.type='shared' AND EXISTS(SELECT 1 FROM license_settings l WHERE l.id='default' AND l.plan='team' AND l.state='active') AND EXISTS(SELECT 1 FROM mailbox_access a WHERE a.mailbox_id=b.id AND a.user_id=${user.id} AND a.permission IN('read_only','send_on_behalf','send_as','full_access') AND (${data.action === "read" || data.action === "unread" ? 1 : 0}=1 OR a.permission='full_access'))))`,
	);
	const allowed = selected.filter(
		(message) => !folder || message.mailbox_id === folder.mailbox_id,
	);
	if (!allowed.length)
		throw new Response("No accessible messages", { status: 404 });
	if (data.action === "delete")
		return permanentlyDeleteMessages(user, allowed, source);

	const status =
		data.action === "archive"
			? "archived"
			: data.action === "trash"
				? "trash"
				: data.action === "spam"
					? "spam"
					: data.action === "inbox" || data.action === "folder"
						? "received"
						: null;
	const read = data.action === "read" ? 1 : data.action === "unread" ? 0 : null;
	await withDatabase((sql) =>
		sql.begin(async (sql) => {
			for (const message of allowed) {
				const [sending] =
					await sql.NativeBulkSendingGuard`SELECT id FROM outbound_jobs WHERE status IN('queued','sending') AND ((message_id=${message.id} AND (status='sending' OR json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.submittedDraftId') IS NOT NULL)) OR json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.submittedDraftId')=${message.id}) LIMIT 1`;
				if (sending && data.action !== "read" && data.action !== "unread")
					throw new Response("A message is being sent. Try again shortly.", {
						status: 409,
					});
				if (
					data.action === "spam" ||
					(data.action === "inbox" && message.status === "spam")
				) {
					await spamFeedback(
						sql,
						user,
						message.id,
						data.action === "spam" ? "spam" : "ham",
						false,
					);
					continue;
				}
				await sql.SourceBulkUpdate`UPDATE messages SET
    status=coalesce(${status},status),read=coalesce(${read},read),
    folder_id=CASE WHEN ${data.action === "read" || data.action === "unread" ? 1 : 0}=1 THEN folder_id ELSE ${folder?.id ?? null} END,
    snoozed_until=CASE WHEN ${data.action}='inbox' THEN NULL ELSE snoozed_until END
    WHERE id=${message.id} AND (status!='draft' OR user_id=${user.id})`;
				if (data.action === "trash")
					await sql.CancelBulkTrashedSends`UPDATE outbound_jobs SET status='cancelled',updated_at=${seconds()} WHERE message_id=${message.id} AND status='queued'`;
				if (data.action !== "inbox")
					await audit(
						sql,
						user,
						null,
						message.id,
						data.action === "read" || data.action === "unread"
							? "email.read"
							: "email.delete",
						{ bulkAction: data.action },
					);
			}
		}),
	);
	return { ok: true };
}
export async function emptyFolder(
	user: User,
	mailboxId: string,
	folder: "trash" | "spam",
) {
	await mailboxAccess(user, mailboxId, "manage");
	const rows = await withDatabase(
		(sql) =>
			sql.EmptyFolderCandidates`SELECT id FROM messages WHERE mailbox_id=${mailboxId} AND status=${folder} ORDER BY created_at,id LIMIT 100`,
	);
	const result = rows.length
		? await bulkAction(
				user,
				{ messageIds: rows.map((row) => row.id), action: "delete" },
				"empty",
			)
		: { deleted: 0 };
	const [count] = await withDatabase(
		(sql) =>
			sql.EmptyFolderRemaining`SELECT count(*) AS remaining FROM messages WHERE mailbox_id=${mailboxId} AND status=${folder}`,
	);
	return {
		ok: true,
		deleted: "deleted" in result ? result.deleted : 0,
		remaining: Number(count?.remaining ?? 0),
	};
}
export async function snooze(
	user: User,
	messageId: string,
	until: string | null,
) {
	const when = until === null ? null : new Date(until);
	if (when && (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()))
		throw new Response("Choose a future snooze time", { status: 400 });
	await withDatabase((sql) =>
		sql.begin(async (sql) => {
			const message = await actionMessage(sql, user, messageId, "manage");
			if (
				message.direction !== "inbound" ||
				(when && message.status !== "received")
			)
				throw new Response("Message not found", { status: 404 });
			await sql.SourceSnooze`UPDATE messages SET snoozed_until=${when ? Math.floor(when.getTime() / 1000) : null} WHERE id=${messageId}`;
		}),
	);
	return { ok: true };
}
export async function toggleStar(user: User, messageId: string) {
	return withDatabase((sql) =>
		sql.begin(async (sql) => {
			await actionMessage(sql, user, messageId, "read");
			const [row] =
				await sql.SourceToggleStar`UPDATE messages SET starred=CASE WHEN starred=1 THEN 0 ELSE 1 END WHERE id=${messageId} RETURNING starred`;
			return { starred: !!row?.starred };
		}),
	);
}

export async function permanentlyDeleteMessages(
	user: User,
	rows: { id: string; mailbox_id: string | null; status: string }[],
	source: "bulk" | "empty" | "retention",
	cutoff: number | null = null,
) {
	const files: string[] = [];
	let deletedCount = 0;
	await withDatabase((sql) =>
		sql.begin(async (tx) => {
			for (const message of rows) {
				if (message.status !== "trash" && message.status !== "spam") continue;
				const attachments =
					await tx.DeletedMessageFiles`SELECT r2_key FROM message_attachments WHERE message_id=${message.id}`;
				const deleted =
					await tx.DeleteTrashedMessage`DELETE FROM messages WHERE id=${message.id} AND status IN ('trash','spam') AND (${cutoff} IS NULL OR trashed_at<${cutoff}) AND NOT EXISTS(SELECT 1 FROM outbound_jobs j WHERE j.message_id=messages.id AND j.status='sending') RETURNING raw_r2_key`;
				if (!deleted.length) continue;
				deletedCount++;
				for (const attachment of attachments) files.push(attachment.r2_key);
				const raw = deleted[0]?.raw_r2_key;
				if (raw) files.push(raw);
				await audit(tx, user, message.mailbox_id, null, "email.delete", {
					permanent: true,
					source,
					messageId: message.id,
					previousStatus: message.status,
				});
			}
		}),
	);
	await deleteUnreferencedObjects(files);
	return {
		ok: true,
		deleted: deletedCount,
		skipped: rows.length - deletedCount,
	};
}
