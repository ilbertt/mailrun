import { dirname } from "node:path";
import { z } from "zod";
import { rename, mkdir, open } from "node:fs/promises";
import { cleanupStaleDriveUploads } from "./retention";
import type { User } from "../../shared/contracts";
import {
	driveRow,
	DriveAccess,
	driveWrite,
	storageLimit,
	storageUsage,
} from "./repository";
import { withDatabase, id, seconds } from "../db";
import { LocalStorage, deleteUnreferencedObjects } from "../storage";
import {
	driveLock,
	writeStream,
	concatenateParts,
	partKey,
	removeUploadFiles,
	uploadTreeKey,
} from "./files";
import {
	canEditDrive,
	DRIVE_MAX_FILE_BYTES,
	DRIVE_PART_BYTES,
	DRIVE_MAX_PARTS,
	DRIVE_UPLOAD_RESUME_MS,
	driveObjectKey,
	normalizeDriveName,
	DRIVE_MAX_DEPTH,
} from "../../lib/drive/utils";
const uploadInput = z.object({
	name: z.unknown().optional(),
	size: z.number().int().nonnegative().max(DRIVE_MAX_FILE_BYTES),
	contentType: z.string().max(10000).optional(),
	parentId: z.string().max(200).nullable().optional(),
	fingerprint: z.string().optional(),
});
export async function startUpload(user: User, value: unknown) {
	await cleanupStaleDriveUploads(1);
	const input = uploadInput.parse(value),
		name = normalizeDriveName(input.name) ?? "Untitled",
		fingerprint = input.fingerprint?.slice(0, 100) ?? "";
	const created = await driveWrite(async (sql) => {
		const access = new DriveAccess(sql);
		let ownerId = user.id,
			parentId: string | null = null;
		if (input.parentId) {
			const parent = await access.item(input.parentId);
			if (
				!parent ||
				parent.kind !== "folder" ||
				!canEditDrive(await access.role(user.id, parent))
			)
				throw new Response("Folder not found", { status: 404 });
			if ((await access.chain(parent)).length >= DRIVE_MAX_DEPTH)
				throw new Response("Folder nesting limit reached", { status: 400 });
			ownerId = parent.ownerId;
			parentId = parent.id;
		}
		if (fingerprint && input.size > 0) {
			const [pending] =
				await sql.NativeResumeDriveUpload`SELECT * FROM drive_items WHERE owner_id=${ownerId} AND parent_id IS ${parentId} AND name=${name} AND size=${input.size} AND upload_fingerprint=${fingerprint} AND upload_id IS NOT NULL AND updated_at>=${seconds() - DRIVE_UPLOAD_RESUME_MS / 1000} AND trashed_at IS NULL LIMIT 1`;
			if (pending) {
				const row = driveRow(pending);
				if (row.uploadId?.startsWith("local_") && row.uploadPartSize) {
					const parts =
						await sql.NativeResumeDriveParts`SELECT part_number,etag FROM drive_upload_parts WHERE item_id=${row.id}`;
					await sql.NativeTouchResumedDrive`UPDATE drive_items SET updated_at=${seconds()} WHERE id=${row.id}`;
					return { row, parts, resumed: true };
				}
			}
		}
		const limit = await storageLimit(sql);
		if (
			limit !== null &&
			(await storageUsage(sql, ownerId)) + input.size > limit
		)
			throw new Response("Not enough Drive storage left for this file", {
				status: 413,
			});
		const itemId = id("drv"),
			uploadId = input.size ? "local_" + crypto.randomUUID() : null;
		const [row] =
			await sql.NativeStartDriveUpload`INSERT INTO drive_items (id,owner_id,parent_id,kind,name,r2_key,size,content_type,upload_id,upload_part_size,upload_fingerprint,created_at,updated_at) VALUES (${itemId},${ownerId},${parentId},'file',${name},${driveObjectKey(ownerId, itemId)},${input.size},${input.contentType?.slice(0, 255) || "application/octet-stream"},${uploadId},${input.size ? DRIVE_PART_BYTES : null},${input.size && fingerprint ? fingerprint : null},${seconds()},${seconds()}) RETURNING *`;
		if (!row) throw new Error("Could not start upload");
		return { row: driveRow(row), parts: [], resumed: false };
	});
	if (input.size === 0) {
		try {
			await new LocalStorage().put(
				created.row.r2Key ??
					driveObjectKey(created.row.ownerId, created.row.id),
				new Uint8Array(),
			);
		} catch (error) {
			await driveWrite(
				(sql) =>
					sql.NativeRemoveEmptyFailedUpload`DELETE FROM drive_items WHERE id=${created.row.id}`,
			);
			throw error;
		}
		const [item] = await withDatabase((sql) =>
			new DriveAccess(sql).dtos([created.row], user.id, () =>
				created.row.ownerId === user.id ? "owner" : "edit",
			),
		);
		return { item, complete: true };
	}
	const uploaded: number[] = [];
	for (const part of created.parts) {
		const expected =
			part.part_number <
			Math.ceil(input.size / (created.row.uploadPartSize ?? DRIVE_PART_BYTES))
				? (created.row.uploadPartSize ?? DRIVE_PART_BYTES)
				: input.size -
					(part.part_number - 1) *
						(created.row.uploadPartSize ?? DRIVE_PART_BYTES);
		const file = new LocalStorage().file(
			partKey(created.row, part.part_number, part.etag),
		);
		if ((await file.exists()) && file.size === expected)
			uploaded.push(part.part_number);
		else
			await withDatabase(
				(sql) =>
					sql.NativeMissingDrivePart`DELETE FROM drive_upload_parts WHERE item_id=${created.row.id} AND part_number=${part.part_number} AND etag=${part.etag}`,
			);
	}
	return {
		id: created.row.id,
		partSize: created.row.uploadPartSize ?? DRIVE_PART_BYTES,
		parts: Math.ceil(
			input.size / (created.row.uploadPartSize ?? DRIVE_PART_BYTES),
		),
		uploaded,
		...(created.resumed ? { resumed: true } : {}),
	};
}
async function pendingUpload(user: User, itemId: string) {
	return withDatabase(async (sql) => {
		const access = new DriveAccess(sql),
			item = await access.item(itemId),
			role = item ? await access.role(user.id, item) : null;
		if (!item?.uploadId || !canEditDrive(role))
			throw new Response("Upload not found", { status: 404 });
		return { item, role: role ?? "view" };
	});
}
export async function uploadPart(
	user: User,
	itemId: string,
	partNumber: number,
	request: Request,
) {
	return driveLock(itemId, async (assertOwned) => {
		const { item } = await pendingUpload(user, itemId),
			partSize = item.uploadPartSize ?? 0,
			total = partSize ? Math.ceil(item.size / partSize) : 0;
		if (
			!Number.isInteger(partNumber) ||
			partNumber < 1 ||
			partNumber > Math.min(total, DRIVE_MAX_PARTS)
		)
			throw new Response("Invalid part number", { status: 400 });
		const expected =
			partNumber < total ? partSize : item.size - (total - 1) * partSize;
		if (
			!request.body ||
			Number(request.headers.get("content-length")) !== expected
		)
			throw new Response("Invalid part size", { status: 400 });
		const provisionalKey = partKey(item, partNumber, crypto.randomUUID()),
			result = await writeStream(provisionalKey, request.body, expected),
			key = partKey(item, partNumber, result.etag);
		await rename(
			new LocalStorage().path(provisionalKey),
			new LocalStorage().path(key),
		);
		try {
			await driveWrite(async (sql) => {
				await assertOwned(sql);
				const access = new DriveAccess(sql),
					current = await access.item(itemId);
				if (
					!current ||
					current.uploadId !== item.uploadId ||
					!canEditDrive(await access.role(user.id, current))
				)
					throw new Response("Upload not found", { status: 404 });
				await sql.NativeRecordDrivePart`INSERT INTO drive_upload_parts (item_id,part_number,etag) VALUES (${item.id},${partNumber},${result.etag}) ON CONFLICT(item_id,part_number) DO UPDATE SET etag=excluded.etag`;
				await sql.NativeTouchDrivePart`UPDATE drive_items SET updated_at=${seconds()} WHERE id=${item.id}`;
			});
		} catch (error) {
			// An expired writer may share this content hash with a newer committed part.
			// Derived part files are removed on completion, abort or expiry.
			throw error;
		}
		return { partNumber, etag: result.etag };
	});
}
export async function finishUpload(user: User, itemId: string) {
	return driveLock(itemId, async (assertOwned) => {
		const { item, role } = await pendingUpload(user, itemId),
			parts = await withDatabase(
				(sql) =>
					sql.NativeCompleteDriveParts`SELECT part_number,etag FROM drive_upload_parts WHERE item_id=${item.id} ORDER BY part_number`,
			),
			total = item.uploadPartSize
				? Math.ceil(item.size / item.uploadPartSize)
				: 0;
		if (
			!total ||
			parts.length !== total ||
			parts.some((part, index) => part.part_number !== index + 1)
		)
			throw new Response("Some parts are missing", { status: 409 });
		const key = item.r2Key ?? driveObjectKey(item.ownerId, item.id);
		const storage = new LocalStorage(),
			staged = uploadTreeKey(item.id) + "/complete_" + crypto.randomUUID();
		await mkdir(dirname(storage.path(key)), { recursive: true, mode: 0o700 });
		await concatenateParts(item, parts, staged);
		const completed = await driveWrite(async (sql) => {
			await assertOwned(sql);
			const access = new DriveAccess(sql),
				current = await access.item(itemId);
			if (
				!current ||
				current.uploadId !== item.uploadId ||
				!canEditDrive(await access.role(user.id, current))
			)
				throw new Response("Upload not found", { status: 404 });
			// Publish under the same SQLite write lock that checks the lease and metadata.
			// An expired finalizer must never overwrite another writer's completed file.
			await rename(storage.path(staged), storage.path(key));
			if (process.platform === "linux") {
				const directory = await open(dirname(storage.path(key)), "r");
				try {
					await directory.sync();
				} finally {
					await directory.close();
				}
			}
			const [row] =
				await sql.NativeFinishDriveUpload`UPDATE drive_items SET upload_id=NULL,upload_part_size=NULL,upload_fingerprint=NULL,updated_at=${seconds()} WHERE id=${item.id} AND upload_id=${item.uploadId} RETURNING *`;
			if (!row) throw new Response("Upload not found", { status: 404 });
			await sql.NativeClearCompletedDriveParts`DELETE FROM drive_upload_parts WHERE item_id=${item.id}`;
			return driveRow(row);
		}).catch(async (error) => {
			await storage.delete(staged);
			await deleteUnreferencedObjects([key]);
			throw error;
		});
		await removeUploadFiles(item.id);
		const [dto] = await withDatabase((sql) =>
			new DriveAccess(sql).dtos([completed], user.id, () => role),
		);
		return { item: dto };
	});
}
export async function abortUpload(user: User, itemId: string) {
	return driveLock(itemId, async (assertOwned) => {
		const { item } = await pendingUpload(user, itemId);
		await driveWrite(async (sql) => {
			await assertOwned(sql);
			return sql.NativeAbortDriveUpload`DELETE FROM drive_items WHERE id=${item.id} AND upload_id=${item.uploadId}`;
		});
		await removeUploadFiles(item.id);
		await deleteUnreferencedObjects([
			item.r2Key ?? driveObjectKey(item.ownerId, item.id),
		]);
		return { ok: true };
	});
}
