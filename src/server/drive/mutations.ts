import { z } from "zod";
import type { User } from "../../shared/contracts";
import type { AppSQL } from "../db";
import { seconds } from "../db";
import {
	DriveAccess,
	driveWrite,
	driveRow,
	type NativeDriveRow,
} from "./repository";
import {
	canEditDrive,
	normalizeDriveName,
	DRIVE_MAX_DEPTH,
} from "../../lib/drive/utils";
import { deleteUnreferencedObjects } from "../storage";
import { removeUploadFiles } from "./files";
export const driveBulkInput = z.object({
	ids: z
		.array(z.string().min(1).max(200))
		.min(1)
		.max(200)
		.transform((ids) => [...new Set(ids)]),
	action: z.enum(["trash", "restore", "move", "delete"]),
	parentId: z.string().max(200).nullable().optional(),
});
export async function removeDriveRows(sql: AppSQL, roots: NativeDriveRow[]) {
	const access = new DriveAccess(sql),
		all = [...roots, ...(await access.descendants(roots.map((row) => row.id)))],
		ids = JSON.stringify([...new Set(all.map((row) => row.id))]);
	await sql.NativeDeleteDriveRows`DELETE FROM drive_items WHERE id IN(SELECT value FROM json_each(${ids}))`;
	return all;
}
export async function cleanDeletedDrive(rows: NativeDriveRow[]) {
	await deleteUnreferencedObjects(
		rows.flatMap((row) => (row.r2Key ? [row.r2Key] : [])),
	);
	for (const row of rows) await removeUploadFiles(row.id);
}
export async function patchDriveItem(
	user: User,
	itemId: string,
	body: { name?: unknown; trashed?: boolean },
) {
	return driveWrite(async (sql) => {
		const access = new DriveAccess(sql),
			item = await access.item(itemId);
		if (!item) throw new Response("Not found", { status: 404 });
		const role = await access.role(
			user.id,
			item,
			body.trashed === false && !!item.trashedAt,
		);
		if (!canEditDrive(role)) throw new Response("Not found", { status: 404 });
		if (body.trashed === false && role !== "owner")
			throw new Response("Only the owner can do that", { status: 403 });
		const name =
			body.name === undefined ? item.name : normalizeDriveName(body.name);
		if (!name) throw new Response("Enter a name", { status: 400 });
		const [row] =
			await sql.NativePatchDriveItem`UPDATE drive_items SET name=${name},trashed_at=${body.trashed === undefined ? (item.trashedAt ? Math.floor(item.trashedAt.getTime() / 1000) : null) : body.trashed ? seconds() : null},updated_at=${seconds()} WHERE id=${item.id} RETURNING *`;
		if (!row) throw new Response("Not found", { status: 404 });
		const [dto] = await access.dtos(
			[driveRow(row)],
			user.id,
			() => role ?? "view",
		);
		return { item: dto };
	});
}
export async function deleteDriveItem(user: User, itemId: string) {
	const removed = await driveWrite(async (sql) => {
		const access = new DriveAccess(sql),
			item = await access.item(itemId);
		if (!item || item.ownerId !== user.id)
			throw new Response("Not found", { status: 404 });
		if (!item.trashedAt)
			throw new Response("Move the item to trash first", { status: 409 });
		return removeDriveRows(sql, [item]);
	});
	await cleanDeletedDrive(removed);
	return { ok: true };
}
export async function bulkDriveItems(user: User, value: unknown) {
	const body = driveBulkInput.parse(value);
	const result = await driveWrite(async (sql) => {
		const access = new DriveAccess(sql),
			rows: NativeDriveRow[] = [];
		for (const itemId of body.ids) {
			const row = await access.item(itemId);
			if (!row) throw new Response("Not found", { status: 404 });
			if (
				row.ownerId !== user.id &&
				!(
					body.action === "trash" &&
					canEditDrive(await access.role(user.id, row))
				)
			)
				throw new Response("Only the owner can change these items", {
					status: 403,
				});
			rows.push(row);
		}
		if (body.action === "delete") {
			const targets = rows.filter((row) => row.trashedAt);
			return {
				count: targets.length,
				removed: await removeDriveRows(sql, targets),
			};
		}
		let parent: string | null = null;
		if (body.action === "move" && body.parentId) {
			const folder = await access.item(body.parentId);
			if (
				!folder ||
				folder.kind !== "folder" ||
				folder.uploadId ||
				folder.ownerId !== user.id ||
				!(await access.role(user.id, folder))
			)
				throw new Response("Folder not found", { status: 404 });
			const chain = await access.chain(folder);
			if (rows.some((row) => chain.some((parent) => parent.id === row.id)))
				throw new Response("Cannot move a folder into itself", { status: 400 });
			const descendants = await access.descendants(
				rows.filter((row) => row.kind === "folder").map((row) => row.id),
			);
			const moved = new Map(
				[...rows, ...descendants].map((row) => [row.id, row]),
			);
			for (const row of moved.values()) {
				let depth = 1,
					current = row;
				const seen = new Set([row.id]);
				while (current.parentId && moved.has(current.parentId)) {
					if (seen.has(current.parentId))
						throw new Response("Folder hierarchy is invalid", { status: 400 });
					seen.add(current.parentId);
					depth++;
					current = moved.get(current.parentId)!;
				}
				if (chain.length + depth > DRIVE_MAX_DEPTH)
					throw new Response("Folder nesting limit reached", { status: 400 });
			}
			parent = folder.id;
		}
		const targets = rows.filter((row) =>
				body.action === "trash"
					? !row.trashedAt
					: body.action === "restore"
						? row.trashedAt
						: row.parentId !== parent || row.trashedAt,
			),
			ids = JSON.stringify(targets.map((row) => row.id));
		await sql.NativeBulkDriveUpdate`UPDATE drive_items SET trashed_at=${body.action === "trash" ? seconds() : null},parent_id=CASE WHEN ${body.action}='move' THEN ${parent} ELSE parent_id END,updated_at=${seconds()} WHERE id IN(SELECT value FROM json_each(${ids}))`;
		return { count: targets.length, removed: [] };
	});
	await cleanDeletedDrive(result.removed);
	return { count: result.count };
}
