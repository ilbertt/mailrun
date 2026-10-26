import { z } from "zod";
import { withDatabase, type AppSQL } from "../db";
import type { DriveRow, DriveRole, DriveItemDto } from "../../lib/drive/types";
import { DRIVE_MAX_DEPTH } from "../../lib/drive/utils";
const stored = z.object({
	id: z.string(),
	owner_id: z.string(),
	parent_id: z.string().nullable(),
	kind: z.enum(["file", "folder"]),
	name: z.string(),
	r2_key: z.string().nullable(),
	size: z.number().nonnegative(),
	content_type: z.string(),
	link_token: z.string().nullable(),
	trashed_at: z.number().nullable(),
	created_at: z.number(),
	updated_at: z.number(),
	upload_id: z.string().nullable(),
	upload_part_size: z.number().nullable(),
	upload_fingerprint: z.string().nullable(),
});
export type NativeDriveRow = DriveRow & {
	uploadId: string | null;
	uploadPartSize: number | null;
	uploadFingerprint: string | null;
};
export function driveRow(value: unknown): NativeDriveRow {
	const r = stored.parse(value);
	return {
		id: r.id,
		ownerId: r.owner_id,
		parentId: r.parent_id,
		kind: r.kind,
		name: r.name,
		r2Key: r.r2_key,
		size: r.size,
		contentType: r.content_type,
		linkToken: r.link_token,
		trashedAt: r.trashed_at === null ? null : new Date(r.trashed_at * 1000),
		createdAt: new Date(r.created_at * 1000),
		updatedAt: new Date(r.updated_at * 1000),
		uploadId: r.upload_id,
		uploadPartSize: r.upload_part_size,
		uploadFingerprint: r.upload_fingerprint,
	};
}
export async function driveWrite<T>(run: (sql: AppSQL) => Promise<T>) {
	return withDatabase((sql) =>
		sql.begin(async (tx) => {
			await tx.NativeDriveWriteFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
			return run(tx);
		}),
	);
}
export class DriveAccess {
	private cache = new Map<string, NativeDriveRow | null>();
	constructor(readonly sql: AppSQL) {}
	remember(rows: NativeDriveRow[]) {
		for (const row of rows) this.cache.set(row.id, row);
	}
	async item(id: string) {
		if (this.cache.has(id)) return this.cache.get(id) ?? null;
		const [row] = await this.sql
			.NativeDriveItem`SELECT * FROM drive_items WHERE id=${id}`;
		const result = row ? driveRow(row) : null;
		this.cache.set(id, result);
		return result;
	}
	async prime(rows: NativeDriveRow[]) {
		this.remember(rows);
		if (!rows.some((row) => row.parentId && !this.cache.has(row.parentId)))
			return;
		const ancestors = await this.sql
			.NativeDriveAncestors`WITH RECURSIVE chain(id,parent_id,depth,path) AS(SELECT id,parent_id,0,','||hex(id)||',' FROM drive_items WHERE id IN(SELECT value FROM json_each(${JSON.stringify(rows.map((row) => row.id))})) UNION ALL SELECT p.id,p.parent_id,c.depth+1,c.path||hex(p.id)||',' FROM drive_items p JOIN chain c ON p.id=c.parent_id WHERE c.depth<${DRIVE_MAX_DEPTH} AND instr(c.path,','||hex(p.id)||',')=0) SELECT * FROM drive_items WHERE id IN(SELECT id FROM chain)`;
		this.remember(ancestors.map(driveRow));
	}
	async chain(item: NativeDriveRow) {
		await this.prime([item]);
		const chain = [item],
			seen = new Set([item.id]);
		let current = item;
		while (current.parentId) {
			if (chain.length >= DRIVE_MAX_DEPTH || seen.has(current.parentId))
				throw new Response("Folder hierarchy is invalid", { status: 404 });
			const parent = await this.item(current.parentId);
			if (!parent) break;
			if (parent.kind !== "folder" || parent.ownerId !== item.ownerId)
				throw new Response("Folder not found", { status: 404 });
			seen.add(parent.id);
			chain.unshift(parent);
			current = parent;
		}
		return chain;
	}
	async role(
		userId: string,
		item: NativeDriveRow,
		allowTrashed = false,
	): Promise<DriveRole | null> {
		const chain = await this.chain(item);
		if (!allowTrashed && chain.some((row) => row.trashedAt)) return null;
		if (item.ownerId === userId) return "owner";
		const shares = await this.sql
			.NativeDriveEffectiveShares`SELECT role FROM drive_shares WHERE user_id=${userId} AND item_id IN(SELECT value FROM json_each(${JSON.stringify(chain.map((row) => row.id))}))`;
		return shares.some((share) => share.role === "edit")
			? "edit"
			: shares.length
				? "view"
				: null;
	}
	async visible(rows: NativeDriveRow[]) {
		await this.prime(rows);
		const kept: NativeDriveRow[] = [];
		for (const row of rows) {
			const chain = await this.chain(row);
			if (!chain.some((parent) => parent.id !== row.id && parent.trashedAt))
				kept.push(row);
		}
		return kept;
	}
	async dtos(
		rows: NativeDriveRow[],
		userId: string,
		roleFor?: (row: NativeDriveRow) => DriveRole,
	): Promise<DriveItemDto[]> {
		if (!rows.length) return [];
		const [owners, shares] = await Promise.all([
			this.sql
				.NativeDriveOwners`SELECT id,name,email,avatar_key FROM users WHERE id IN(SELECT value FROM json_each(${JSON.stringify([...new Set(rows.map((row) => row.ownerId))])}))`,
			this.sql
				.NativeDriveDtoShares`SELECT item_id FROM drive_shares WHERE item_id IN(SELECT value FROM json_each(${JSON.stringify(rows.map((row) => row.id))}))`,
		]);
		const ownerMap = new Map(owners.map((row) => [row.id, row])),
			shared = new Set(shares.map((row) => row.item_id));
		return rows.map((row) => ({
			id: row.id,
			kind: row.kind,
			name: row.name,
			size: row.size,
			contentType: row.contentType,
			parentId: row.parentId,
			ownerId: row.ownerId,
			ownerName:
				ownerMap.get(row.ownerId)?.name ||
				ownerMap.get(row.ownerId)?.email ||
				"",
			ownerHasAvatar: !!ownerMap.get(row.ownerId)?.avatar_key,
			role: roleFor ? roleFor(row) : row.ownerId === userId ? "owner" : "view",
			shared: shared.has(row.id) || !!row.linkToken,
			linkToken: row.ownerId === userId ? row.linkToken : null,
			trashedAt: row.trashedAt?.toISOString() ?? null,
			updatedAt: row.updatedAt.toISOString(),
		}));
	}
	async descendants(roots: string[]) {
		if (!roots.length) return [];
		const rows = await this.sql
			.NativeDriveDescendants`WITH RECURSIVE tree(id,depth,path) AS(SELECT id,0,','||hex(id)||',' FROM drive_items WHERE parent_id IN(SELECT value FROM json_each(${JSON.stringify(roots)})) UNION ALL SELECT d.id,t.depth+1,t.path||hex(d.id)||',' FROM drive_items d JOIN tree t ON d.parent_id=t.id WHERE t.depth<${DRIVE_MAX_DEPTH} AND instr(t.path,','||hex(d.id)||',')=0) SELECT * FROM drive_items WHERE id IN(SELECT id FROM tree)`;
		return rows.map(driveRow);
	}
}
export async function storageUsage(sql: AppSQL, ownerId: string) {
	const [usage] =
		await sql.NativeDriveUsage`SELECT COALESCE(sum(size),0) AS total FROM drive_items WHERE owner_id=${ownerId}`;
	return Number(usage?.total ?? 0);
}
export async function storageLimit(sql: AppSQL) {
	const [settings] =
		await sql.NativeDriveStorageLimit`SELECT drive_storage_limit_bytes FROM app_settings WHERE id='default'`;
	return settings?.drive_storage_limit_bytes &&
		settings.drive_storage_limit_bytes > 0
		? settings.drive_storage_limit_bytes
		: null;
}
