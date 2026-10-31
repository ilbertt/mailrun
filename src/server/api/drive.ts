import { z } from "zod";
import type { User } from "../../shared/contracts";
import { withDatabase } from "../db";
import { DriveAccess } from "../drive/repository";
import {
	listDrive,
	createDriveFolder,
	listDriveFolders,
} from "../drive/listing";
import {
	startUpload,
	uploadPart,
	finishUpload,
	abortUpload,
} from "../drive/uploads";
import {
	patchDriveItem,
	deleteDriveItem,
	bulkDriveItems,
	driveBulkInput,
} from "../drive/mutations";
import {
	getDriveShares,
	shareDriveItem,
	revokeDriveShare,
	linkDriveItem,
} from "../drive/sharing";
import { streamDriveFile } from "../drive/content";
import { driveAttachment, changeDriveAttachments } from "../drive/attachments";
import { imageResponse } from "../images";
export async function driveApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	const url = new URL(request.url),
		path = url.pathname,
		method = request.method,
		json = Response.json;
	if (!path.startsWith("/api/drive/")) return null;
	if (path === "/api/drive/items") {
		if (method === "GET") return json(await listDrive(user, url.searchParams));
		if (method === "POST")
			return json(
				await createDriveFolder(
					user,
					z
						.object({
							name: z.unknown(),
							parentId: z.string().nullable().optional(),
						})
						.parse(await request.json()),
				),
			);
	}
	if (path === "/api/drive/folders" && method === "GET")
		return json(await listDriveFolders(user));
	if (path === "/api/drive/items/bulk" && method === "POST")
		return json(await bulkDriveItems(user, await request.json()));
	if (path === "/api/drive/attachments" && method === "POST") {
		const body = driveBulkInput
			.extend({ action: z.enum(["trash", "restore", "delete"]) })
			.parse(await request.json());
		return json(await changeDriveAttachments(user, body.ids, body.action));
	}
	if (path === "/api/drive/upload" && method === "POST")
		return json(await startUpload(user, await request.json()));
	const upload = /^\/api\/drive\/upload\/([^/]+)$/.exec(path);
	if (upload) {
		const itemId = decodeURIComponent(upload[1] ?? "");
		if (method === "PUT")
			return json(
				await uploadPart(
					user,
					itemId,
					Number(url.searchParams.get("part")),
					request,
				),
			);
		if (method === "POST") return json(await finishUpload(user, itemId));
		if (method === "DELETE") return json(await abortUpload(user, itemId));
	}
	const itemMatch =
		/^\/api\/drive\/items\/([^/]+)(?:\/(content|shares|link))?$/.exec(path);
	if (itemMatch) {
		const itemId = decodeURIComponent(itemMatch[1] ?? ""),
			operation = itemMatch[2];
		if (operation === "content" && ["GET", "HEAD"].includes(method)) {
			const item = await withDatabase(async (sql) => {
				const access = new DriveAccess(sql),
					row = await access.item(itemId);
				if (!row || row.uploadId || !(await access.role(user.id, row)))
					throw new Response("Not found", { status: 404 });
				return row;
			});
			return streamDriveFile(
				request,
				item,
				url.searchParams.get("download") === "1",
			);
		}
		if (operation === "shares") {
			if (method === "GET") return json(await getDriveShares(user, itemId));
			if (method === "POST") {
				const body = z
					.object({
						email: z.string().trim().min(1),
						role: z.enum(["view", "edit"]).optional().default("view"),
					})
					.parse(await request.json());
				return json(await shareDriveItem(user, itemId, body.email, body.role));
			}
			if (method === "DELETE") {
				const shareId = url.searchParams.get("shareId");
				if (!shareId) throw new Response("Missing share", { status: 400 });
				return json(await revokeDriveShare(user, itemId, shareId));
			}
		}
		if (operation === "link" && method === "POST") {
			const body = z
				.object({ enabled: z.boolean() })
				.parse(await request.json());
			return json(await linkDriveItem(user, itemId, body.enabled));
		}
		if (!operation) {
			if (method === "PATCH")
				return json(
					await patchDriveItem(
						user,
						itemId,
						z
							.object({
								name: z.unknown().optional(),
								trashed: z.boolean().optional(),
							})
							.parse(await request.json()),
					),
				);
			if (method === "DELETE") return json(await deleteDriveItem(user, itemId));
		}
	}
	const attachment = /^\/api\/drive\/attachments\/([^/]+)\/content$/.exec(path);
	if (attachment && ["GET", "HEAD"].includes(method))
		return streamDriveFile(
			request,
			await driveAttachment(user, decodeURIComponent(attachment[1] ?? "")),
			url.searchParams.get("download") === "1",
		);
	const avatar = /^\/api\/drive\/owners\/([^/]+)\/avatar$/.exec(path);
	if (avatar && method === "GET") {
		const target = decodeURIComponent(avatar[1] ?? "");
		const [row] = await withDatabase(
			(sql) =>
				sql.NativeDriveOwnerAvatar`SELECT avatar_key FROM users WHERE id=${target} AND (id=${user.id} OR EXISTS(SELECT 1 FROM drive_shares s JOIN drive_items d ON d.id=s.item_id WHERE d.owner_id=users.id AND s.user_id=${user.id}))`,
		);
		return row?.avatar_key
			? imageResponse(request, row.avatar_key)
			: new Response("Not found", { status: 404 });
	}
	return null;
}
