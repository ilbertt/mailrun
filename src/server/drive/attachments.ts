import type { User } from "../../shared/contracts";
import type { DriveItemDto, DriveRow } from "../../lib/drive/types";
import { type DriveCategory } from "../../lib/drive/categories";
import { withDatabase, seconds, type AppSQL } from "../db";
import { driveWrite } from "./repository";
import { deleteUnreferencedObjects } from "../storage";
export async function driveMailboxes(sql: AppSQL, user: User) {
	return sql.NativeDriveAccessibleMailboxes`SELECT b.id,CASE WHEN b.user_id=${user.id} THEN 'full_access' ELSE a.permission END AS permission FROM mailboxes b LEFT JOIN mailbox_access a ON a.mailbox_id=b.id AND a.user_id=${user.id} WHERE b.disabled=0 AND (b.user_id=${user.id} OR (b.type='shared' AND a.id IS NOT NULL AND EXISTS(SELECT 1 FROM license_settings WHERE id='default' AND plan='team' AND state='active')))`;
}
export async function listDriveAttachments(
	sql: AppSQL,
	user: User,
	categories: DriveCategory[],
	trashed = false,
): Promise<DriveItemDto[]> {
	const boxes = await driveMailboxes(sql, user),
		permissions = new Map(boxes.map((box) => [box.id, box.permission]));
	const rows =
		await sql.NativeDriveEmailAttachments`/* @notNull id */ /* @notNull message_date */ WITH classified AS(SELECT a.*,m.from_addr,m.subject,m.direction,m.mailbox_id,m.created_at AS message_date,CASE
 WHEN lower(a.content_type) LIKE 'image/%' OR EXISTS(SELECT 1 FROM json_each('["jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "heif", "bmp", "tif", "tiff", "svg", "raw", "dng"]') e WHERE lower(a.filename) LIKE '%.'||e.value) THEN 'photos'
 WHEN lower(a.content_type) LIKE 'video/%' OR EXISTS(SELECT 1 FROM json_each('["mp4", "mov", "m4v", "mkv", "webm", "avi", "wmv", "mpg", "mpeg", "3gp"]') e WHERE lower(a.filename) LIKE '%.'||e.value) THEN 'videos'
 WHEN lower(a.content_type) LIKE 'text/%' OR lower(a.content_type) LIKE 'application/vnd.%' OR lower(a.content_type) IN('application/pdf','application/msword','application/rtf','application/json','application/epub+zip') OR EXISTS(SELECT 1 FROM json_each('["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "rtf", "odt", "ods", "odp", "pages", "numbers", "key", "epub"]') e WHERE lower(a.filename) LIKE '%.'||e.value) THEN 'documents' ELSE 'others' END AS category,CASE WHEN lower(a.content_type) LIKE 'video/%' OR EXISTS(SELECT 1 FROM json_each('["mp4", "mov", "m4v", "mkv", "webm", "avi", "wmv", "mpg", "mpeg", "3gp"]') e WHERE lower(a.filename) LIKE '%.'||e.value) THEN 1 ELSE 0 END AS video_match FROM message_attachments a JOIN messages m ON m.id=a.message_id WHERE (m.mailbox_id IN(SELECT value FROM json_each(${JSON.stringify(boxes.map((box) => box.id))})) OR (m.mailbox_id IS NULL AND m.user_id=${user.id})) AND a.disposition='attachment' AND ((${trashed ? 1 : 0}=1 AND a.trashed_at IS NOT NULL) OR (${trashed ? 1 : 0}=0 AND a.trashed_at IS NULL)) AND m.status NOT IN('draft','trash','spam','template') ORDER BY m.created_at DESC) SELECT * FROM classified WHERE (${categories.length}=0 OR category IN(SELECT value FROM json_each(${JSON.stringify(categories)})) OR (${categories.includes("videos") ? 1 : 0}=1 AND video_match=1)) ORDER BY message_date DESC LIMIT 500`;
	return rows.map((row) => ({
		id: row.id,
		kind: "file",
		name: row.filename,
		size: row.size,
		contentType: row.content_type,
		parentId: null,
		ownerId: row.message_id,
		ownerName: (
			row.from_addr.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/)?.[1] ??
			row.from_addr
		).trim(),
		ownerHasAvatar: false,
		role: "view",
		shared: false,
		linkToken: null,
		trashedAt:
			row.trashed_at === null
				? null
				: new Date(row.trashed_at * 1000).toISOString(),
		updatedAt: new Date(row.message_date * 1000).toISOString(),
		source: {
			messageId: row.message_id,
			subject: row.subject ?? "",
			direction: row.direction === "outbound" ? "outbound" : "inbound",
			canDelete:
				!row.mailbox_id || permissions.get(row.mailbox_id) !== "read_only",
		},
	}));
}
export async function changeDriveAttachments(
	user: User,
	ids: string[],
	action: "trash" | "restore" | "delete",
) {
	const result = await driveWrite(async (sql) => {
		const boxes = await driveMailboxes(sql, user),
			permissions = new Map(boxes.map((box) => [box.id, box.permission]));
		const rows =
			await sql.NativeDriveAttachmentMutationRows`SELECT a.*,m.user_id,m.mailbox_id,m.status FROM message_attachments a JOIN messages m ON m.id=a.message_id WHERE a.id IN(SELECT value FROM json_each(${JSON.stringify(ids)}))`;
		const allowed = rows.filter(
			(row) =>
				(!row.mailbox_id
					? row.user_id === user.id
					: permissions.has(row.mailbox_id) &&
						permissions.get(row.mailbox_id) !== "read_only") &&
				(!["draft", "template"].includes(row.status) ||
					row.user_id === user.id),
		);
		const denied = rows.length - allowed.length;
		if (denied && !allowed.length)
			throw new Response("You cannot change these attachments", {
				status: 403,
			});
		const targets = allowed.filter((row) =>
				action === "trash" ? row.trashed_at === null : row.trashed_at !== null,
			),
			targetsJson = JSON.stringify(targets.map((row) => row.id));
		if (action === "delete")
			await sql.NativeDriveDeleteEmailAttachments`DELETE FROM message_attachments WHERE id IN(SELECT value FROM json_each(${targetsJson}))`;
		else
			await sql.NativeDriveTrashEmailAttachments`UPDATE message_attachments SET trashed_at=${action === "trash" ? seconds() : null} WHERE id IN(SELECT value FROM json_each(${targetsJson}))`;
		return {
			count: targets.length,
			denied,
			keys: action === "delete" ? targets.map((row) => row.r2_key) : [],
		};
	});
	await deleteUnreferencedObjects(result.keys);
	return { count: result.count, denied: result.denied };
}
export async function driveAttachment(
	user: User,
	itemId: string,
): Promise<DriveRow> {
	return withDatabase(async (sql) => {
		const boxes = await driveMailboxes(sql, user),
			[row] =
				await sql.NativeDriveAttachmentContent`/* @notNull id */ /* @notNull created_at */ SELECT a.*,m.user_id,m.mailbox_id,m.status FROM message_attachments a JOIN messages m ON m.id=a.message_id WHERE a.id=${itemId}`;
		if (
			!row ||
			row.trashed_at !== null ||
			(!row.mailbox_id
				? row.user_id !== user.id
				: !boxes.some((box) => box.id === row.mailbox_id)) ||
			(["draft", "template"].includes(row.status) && row.user_id !== user.id)
		)
			throw new Response("Not found", { status: 404 });
		return {
			id: row.id,
			ownerId: row.message_id,
			parentId: null,
			kind: "file",
			name: row.filename,
			r2Key: row.r2_key,
			size: row.size,
			contentType: row.content_type,
			linkToken: null,
			trashedAt: null,
			createdAt: new Date(row.created_at * 1000),
			updatedAt: new Date(row.created_at * 1000),
		};
	});
}
