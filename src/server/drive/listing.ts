import type { User } from "../../shared/contracts";
import { withDatabase, id, seconds } from "../db";
import {
	DriveAccess,
	driveRow,
	driveWrite,
	storageUsage,
	storageLimit,
} from "./repository";
import { parseDriveCategories } from "../../lib/drive/categories";
import {
	normalizeDriveName,
	canEditDrive,
	DRIVE_MAX_DEPTH,
	toDriveCrumbs,
} from "../../lib/drive/utils";
import { listDriveAttachments } from "./attachments";
export async function listDrive(user: User, params: URLSearchParams) {
	return withDatabase(async (sql) => {
		const access = new DriveAccess(sql),
			parent = params.get("parent"),
			view = params.get("view") ?? "my",
			query = params.get("q")?.trim() ?? "",
			categories = parseDriveCategories(params.get("types"));
		let role: "owner" | "edit" | "view" =
				view === "shared" || view === "attachments" ? "view" : "owner",
			path: { id: string; name: string }[] = [],
			owner = user.id;
		if (parent) {
			const folder = await access.item(parent);
			const allowed =
				folder?.kind === "folder" ? await access.role(user.id, folder) : null;
			if (!folder || !allowed)
				throw new Response("Folder not found", { status: 404 });
			role = allowed;
			owner = folder.ownerId;
			let chain = await access.chain(folder);
			if (role !== "owner") {
				const shares =
					await sql.NativeDriveBreadcrumbShares`SELECT item_id FROM drive_shares WHERE user_id=${user.id} AND item_id IN(SELECT value FROM json_each(${JSON.stringify(chain.map((row) => row.id))}))`;
				const index = chain.findIndex((row) =>
					shares.some((share) => share.item_id === row.id),
				);
				if (index >= 0) chain = chain.slice(index);
			}
			path = toDriveCrumbs(chain);
		}
		const meta = {
			storageUsed: await storageUsage(sql, user.id),
			storageLimit: await storageLimit(sql),
		};
		if (!parent && view === "attachments")
			return {
				items: await listDriveAttachments(sql, user, categories),
				path,
				role,
				...meta,
			};
		const raw =
			await sql.NativeListDriveItems`WITH classified AS(SELECT d.*,CASE
 WHEN lower(content_type) LIKE 'image/%' OR EXISTS(SELECT 1 FROM json_each('["jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "heif", "bmp", "tif", "tiff", "svg", "raw", "dng"]') e WHERE lower(name) LIKE '%.'||e.value) THEN 'photos'
 WHEN lower(content_type) LIKE 'video/%' OR EXISTS(SELECT 1 FROM json_each('["mp4", "mov", "m4v", "mkv", "webm", "avi", "wmv", "mpg", "mpeg", "3gp"]') e WHERE lower(name) LIKE '%.'||e.value) THEN 'videos'
 WHEN lower(content_type) LIKE 'text/%' OR lower(content_type) LIKE 'application/vnd.%' OR lower(content_type) IN('application/pdf','application/msword','application/rtf','application/json','application/epub+zip') OR EXISTS(SELECT 1 FROM json_each('["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "rtf", "odt", "ods", "odp", "pages", "numbers", "key", "epub"]') e WHERE lower(name) LIKE '%.'||e.value) THEN 'documents' ELSE 'others' END AS category,CASE WHEN lower(content_type) LIKE 'video/%' OR EXISTS(SELECT 1 FROM json_each('["mp4", "mov", "m4v", "mkv", "webm", "avi", "wmv", "mpg", "mpeg", "3gp"]') e WHERE lower(name) LIKE '%.'||e.value) THEN 1 ELSE 0 END AS video_match,
 (SELECT role FROM drive_shares WHERE item_id=d.id AND user_id=${user.id}) AS shared_role,(SELECT created_at FROM drive_shares WHERE item_id=d.id AND user_id=${user.id}) AS shared_at FROM drive_items d)
 SELECT * FROM classified WHERE
 ((${parent} IS NOT NULL AND parent_id=${parent} AND trashed_at IS NULL AND upload_id IS NULL)
 OR (${parent} IS NULL AND ${view}='shared' AND shared_role IS NOT NULL AND trashed_at IS NULL AND upload_id IS NULL)
 OR (${parent} IS NULL AND ${view}='trash' AND owner_id=${owner} AND trashed_at IS NOT NULL)
 OR (${parent} IS NULL AND ${view} NOT IN('shared','trash','attachments') AND owner_id=${owner} AND trashed_at IS NULL AND upload_id IS NULL
 AND ((${query}<>'' AND name LIKE ${"%" + query.replace(/[\\%_]/g, "\\$&") + "%"} ESCAPE '\\') OR (${query}='' AND ((${categories.length}=0 AND parent_id IS NULL) OR (${categories.length}>0 AND kind='file'))))))
 AND (${categories.length}=0 OR kind='folder' OR category IN(SELECT value FROM json_each(${JSON.stringify(categories)})) OR (${categories.includes("videos") ? 1 : 0}=1 AND video_match=1))
 ORDER BY CASE WHEN ${view}='trash' THEN trashed_at WHEN ${view}='shared' THEN shared_at ELSE updated_at END DESC LIMIT ${parent || view === "trash" || view === "shared" ? 2147483647 : query ? 200 : 1000}`;
		const rows =
			view === "trash" && !parent
				? raw.map(driveRow)
				: await access.visible(raw.map(driveRow));
		const roles = new Map(
			raw.map((row) => [
				row.id,
				row.shared_role === "edit" ? ("edit" as const) : ("view" as const),
			]),
		);
		let items = await access.dtos(rows, user.id, (row) =>
			parent
				? role
				: view === "shared"
					? (roles.get(row.id) ?? "view")
					: "owner",
		);
		if (!parent && view === "trash") {
			items = [
				...items,
				...(await listDriveAttachments(sql, user, categories, true)),
			].sort((a, b) => (b.trashedAt ?? "").localeCompare(a.trashedAt ?? ""));
		}
		return { items, path, role, ...meta };
	});
}
export async function createDriveFolder(
	user: User,
	body: { name?: unknown; parentId?: string | null },
) {
	const name = normalizeDriveName(body.name);
	if (!name) throw new Response("Enter a folder name", { status: 400 });
	return driveWrite(async (sql) => {
		const access = new DriveAccess(sql);
		let owner = user.id,
			parent: string | null = null;
		if (body.parentId) {
			const folder = await access.item(body.parentId);
			if (
				!folder ||
				folder.kind !== "folder" ||
				!canEditDrive(await access.role(user.id, folder))
			)
				throw new Response("Folder not found", { status: 404 });
			if ((await access.chain(folder)).length >= DRIVE_MAX_DEPTH)
				throw new Response("Folder nesting limit reached", { status: 400 });
			owner = folder.ownerId;
			parent = folder.id;
		}
		const [row] =
			await sql.NativeCreateDriveFolder`INSERT INTO drive_items (id,owner_id,parent_id,kind,name,size,content_type,created_at,updated_at) VALUES (${id("drv")},${owner},${parent},'folder',${name},0,'application/x-directory',${seconds()},${seconds()}) RETURNING *`;
		if (!row) throw new Error("Could not create folder");
		const [item] = await access.dtos([driveRow(row)], user.id, () =>
			owner === user.id ? "owner" : "edit",
		);
		return { item };
	});
}
export async function listDriveFolders(user: User) {
	return withDatabase(async (sql) => {
		const rows =
			await sql.NativeListDriveFolders`SELECT * FROM drive_items WHERE owner_id=${user.id} AND kind='folder' AND trashed_at IS NULL AND upload_id IS NULL ORDER BY name COLLATE NOCASE LIMIT 2000`;
		const access = new DriveAccess(sql);
		return {
			folders: (await access.visible(rows.map(driveRow))).map((row) => ({
				id: row.id,
				name: row.name,
				parentId: row.parentId,
			})),
		};
	});
}
