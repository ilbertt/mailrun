import type { User } from "../../shared/contracts";
import { withDatabase, id, seconds, type AppSQL } from "../db";
import { DriveAccess, driveWrite, driveRow } from "./repository";
import { streamDriveFile } from "./content";
async function ownedItem(sql: AppSQL, user: User, itemId: string) {
	const access = new DriveAccess(sql),
		item = await access.item(itemId);
	if (
		!item ||
		item.uploadId ||
		item.ownerId !== user.id ||
		!(await access.role(user.id, item))
	)
		throw new Response("Not found", { status: 404 });
	return item;
}
async function shares(sql: AppSQL, itemId: string) {
	const rows =
		await sql.NativeListDriveShares`/* @notNull id */ SELECT s.id,s.user_id,u.name,u.email,s.role FROM drive_shares s JOIN users u ON u.id=s.user_id WHERE s.item_id=${itemId} ORDER BY s.created_at,s.id`;
	return rows.map((row) => ({
		id: row.id,
		userId: row.user_id,
		name: row.name,
		email: row.email,
		role: row.role,
	}));
}
export async function getDriveShares(user: User, itemId: string) {
	return withDatabase(async (sql) => {
		const item = await ownedItem(sql, user, itemId);
		return { shares: await shares(sql, item.id), linkToken: item.linkToken };
	});
}
export async function shareDriveItem(
	user: User,
	itemId: string,
	email: string,
	role: "view" | "edit",
) {
	return driveWrite(async (sql) => {
		const item = await ownedItem(sql, user, itemId),
			[target] =
				await sql.NativeDriveShareRecipient`SELECT id FROM users WHERE lower(email)=${email.trim().toLowerCase()} LIMIT 1`;
		if (!target)
			throw new Response("No account uses that email address", { status: 404 });
		if (target.id === user.id)
			throw new Response("You already own this item", { status: 400 });
		await sql.NativeUpsertDriveShare`INSERT INTO drive_shares (id,item_id,user_id,role,created_at) VALUES (${id("dshr")},${item.id},${target.id},${role},${seconds()}) ON CONFLICT(item_id,user_id) DO UPDATE SET role=excluded.role`;
		return { shares: await shares(sql, item.id) };
	});
}
export async function revokeDriveShare(
	user: User,
	itemId: string,
	shareId: string,
) {
	return driveWrite(async (sql) => {
		const item = await ownedItem(sql, user, itemId);
		await sql.NativeRevokeDriveShare`DELETE FROM drive_shares WHERE id=${shareId} AND item_id=${item.id}`;
		return { shares: await shares(sql, item.id) };
	});
}
export async function linkDriveItem(
	user: User,
	itemId: string,
	enabled: boolean,
) {
	return driveWrite(async (sql) => {
		const item = await ownedItem(sql, user, itemId),
			token = enabled
				? (item.linkToken ??
					crypto.randomUUID().replaceAll("-", "") +
						crypto.randomUUID().replaceAll("-", ""))
				: null;
		await sql.NativeLinkDriveItem`UPDATE drive_items SET link_token=${token},updated_at=${seconds()} WHERE id=${item.id}`;
		return { linkToken: token };
	});
}
const publicItem = (item: ReturnType<typeof driveRow>) => ({
	id: item.id,
	kind: item.kind,
	name: item.name,
	size: item.size,
	contentType: item.contentType,
	updatedAt: item.updatedAt.toISOString(),
});
export async function publicDriveApi(
	request: Request,
): Promise<Response | null> {
	const url = new URL(request.url),
		match = /^\/api\/drive\/public\/([^/]+)$/.exec(url.pathname);
	if (!match || !["GET", "HEAD"].includes(request.method)) return null;
	const token = decodeURIComponent(match[1] ?? "");
	if (token.length > 200) throw new Response("Link not found", { status: 404 });
	const result = await withDatabase(async (sql) => {
		const [rootRow] =
			await sql.NativePublicDriveRoot`SELECT * FROM drive_items WHERE link_token=${token} AND trashed_at IS NULL AND upload_id IS NULL LIMIT 1`;
		if (!rootRow) throw new Response("Link not found", { status: 404 });
		const access = new DriveAccess(sql),
			root = driveRow(rootRow),
			target = url.searchParams.get("item"),
			item = target && target !== root.id ? await access.item(target) : root;
		if (!item || item.uploadId)
			throw new Response("Link not found", { status: 404 });
		const chain = await access.chain(item),
			index = chain.findIndex((row) => row.id === root.id);
		if (index < 0 || chain.some((row) => row.trashedAt))
			throw new Response("Link not found", { status: 404 });
		if (
			url.searchParams.get("content") === "1" ||
			url.searchParams.get("download") === "1"
		)
			return { file: item };
		const rows =
			item.kind === "folder"
				? await sql.NativePublicDriveChildren`SELECT * FROM drive_items WHERE parent_id=${item.id} AND trashed_at IS NULL AND upload_id IS NULL`
				: [];
		return {
			listing: {
				item: publicItem(item),
				items: rows.map((row) => publicItem(driveRow(row))),
				path: chain.slice(index).map((row) => ({ id: row.id, name: row.name })),
			},
		};
	});
	if (result.file)
		return streamDriveFile(
			request,
			result.file,
			url.searchParams.get("download") === "1",
		);
	return request.method === "HEAD"
		? new Response(null, {
				headers: {
					"Content-Type": "application/json",
					"Cache-Control": "no-store",
				},
			})
		: Response.json(result.listing, {
				headers: { "Cache-Control": "no-store" },
			});
}
