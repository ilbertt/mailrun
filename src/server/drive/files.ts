import { mkdir, open, rename, unlink, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { LocalStorage } from "../storage";
import { withDatabase, id, seconds, type AppSQL } from "../db";
import type { NativeDriveRow } from "./repository";
export const uploadTreeKey = (itemId: string) =>
	`drive-uploads/${encodeURIComponent(itemId)}`;
export const partKey = (item: NativeDriveRow, number: number, etag: string) =>
	`${uploadTreeKey(item.id)}/${encodeURIComponent(item.uploadId ?? "")}/${number}-${encodeURIComponent(etag)}`;
export async function removeUploadFiles(itemId: string) {
	await rm(new LocalStorage().path(uploadTreeKey(itemId)), {
		recursive: true,
		force: true,
	});
}
export async function clearDriveRuntimeLeases() {
	await withDatabase(
		(sql) =>
			sql.NativeClearDriveRuntimeLeases`DELETE FROM mailrun_job_leases WHERE name LIKE 'drive:%'`,
	);
}
export async function driveLock<T>(
	itemId: string,
	run: (assertOwned: (sql: AppSQL) => Promise<void>) => Promise<T>,
): Promise<T> {
	const name = "drive:" + itemId,
		owner = id("drive-lock");
	const [lock] = await withDatabase(
		(sql) =>
			sql.NativeClaimDriveLock`INSERT INTO mailrun_job_leases (name,owner,expires_at) VALUES (${name},${owner},${seconds() + 60}) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE mailrun_job_leases.expires_at<${seconds()} RETURNING owner`,
	);
	if (!lock)
		throw new Response("This file is being updated. Try again.", {
			status: 409,
		});
	let lost = false;
	const heartbeat = setInterval(() => {
		void withDatabase(
			(sql) =>
				sql.NativeRenewDriveLock`UPDATE mailrun_job_leases SET expires_at=${seconds() + 60} WHERE name=${name} AND owner=${owner} RETURNING owner`,
		)
			.then((rows) => {
				if (!rows.length) lost = true;
			})
			.catch(() => {
				lost = true;
			});
	}, 15000);
	try {
		return await run(async (sql) => {
			const [lease] =
				await sql.NativeCheckDriveLock`SELECT owner FROM mailrun_job_leases WHERE name=${name} AND owner=${owner} AND expires_at>=${seconds()}`;
			if (lost || !lease)
				throw new Response("Upload changed. Try again.", { status: 409 });
		});
	} finally {
		clearInterval(heartbeat);
		await withDatabase(
			(sql) =>
				sql.NativeReleaseDriveLock`DELETE FROM mailrun_job_leases WHERE name=${name} AND owner=${owner}`,
		);
		if (lost) console.warn("A Drive operation lost its runtime lease");
	}
}
async function writeChunk(
	file: Awaited<ReturnType<typeof open>>,
	bytes: Uint8Array,
) {
	let offset = 0;
	while (offset < bytes.length) {
		const { bytesWritten } = await file.write(
			bytes,
			offset,
			bytes.length - offset,
		);
		if (!bytesWritten) throw new Error("Could not write file");
		offset += bytesWritten;
	}
}
export async function writeStream(
	key: string,
	body: ReadableStream<Uint8Array>,
	expected: number,
	stagingKey?: string,
) {
	const storage = new LocalStorage(),
		path = storage.path(key),
		temporary = storage.path(`${stagingKey ?? key}.${crypto.randomUUID()}.tmp`);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await mkdir(dirname(temporary), { recursive: true, mode: 0o700 });
	const file = await open(temporary, "wx", 0o600),
		reader = body.getReader(),
		hash = new Bun.CryptoHasher("sha256");
	let size = 0,
		collectedAt = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.length;
			if (size > expected)
				throw new Response("Invalid part size", { status: 400 });
			hash.update(chunk.value);
			await writeChunk(file, chunk.value);
			// Completed async writes otherwise retain external buffers until a later heap cycle.
			// Bound transient memory while receiving and assembling 64 MiB parts on nibrun.
			if (size - collectedAt >= 8 * 1024 * 1024) {
				Bun.gc(true);
				collectedAt = size;
			}
		}
		if (size !== expected)
			throw new Response("Invalid part size", { status: 400 });
		await file.sync();
		await file.close();
		await rename(temporary, path);
		if (process.platform === "linux") {
			const folder = await open(dirname(path), "r");
			try {
				await folder.sync();
			} finally {
				await folder.close();
			}
		}
		return { size, etag: hash.digest("hex") };
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
		await file.close().catch(() => {});
		await unlink(temporary).catch(() => {});
	}
}
export async function concatenateParts(
	item: NativeDriveRow,
	parts: { part_number: number; etag: string }[],
	key: string,
) {
	const ordered = parts.slice().sort((a, b) => a.part_number - b.part_number),
		storage = new LocalStorage();
	let number = 0,
		reader: ReadableStreamDefaultReader<Uint8Array> | null = null,
		hasher = new Bun.CryptoHasher("sha256");
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				while (true) {
					const part = ordered[number];
					if (!part) {
						controller.close();
						return;
					}
					if (!reader) {
						const file = storage.file(
							partKey(item, part.part_number, part.etag),
						);
						if (!(await file.exists())) {
							await invalidatePart(item, part);
							throw new Response("Some upload parts are missing", {
								status: 409,
							});
						}
						reader = file.stream().getReader();
						hasher = new Bun.CryptoHasher("sha256");
					}
					const result = await reader.read();
					if (result.done) {
						reader.releaseLock();
						reader = null;
						if (hasher.digest("hex") !== part.etag) {
							await invalidatePart(item, part);
							throw new Response(
								"An upload part changed. Upload that part again.",
								{ status: 409 },
							);
						}
						number++;
						continue;
					}
					hasher.update(result.value);
					controller.enqueue(result.value);
					return;
				}
			} catch (error) {
				controller.error(error);
			}
		},
		async cancel() {
			await reader?.cancel();
			reader?.releaseLock();
			reader = null;
		},
	});
	return writeStream(
		key,
		body,
		item.size,
		uploadTreeKey(item.id) + "/assembled",
	);
}

async function invalidatePart(
	item: NativeDriveRow,
	part: { part_number: number; etag: string },
) {
	await withDatabase(
		(sql) =>
			sql.NativeInvalidateDrivePart`DELETE FROM drive_upload_parts WHERE item_id=${item.id} AND part_number=${part.part_number} AND etag=${part.etag}`,
	);
	await new LocalStorage().delete(partKey(item, part.part_number, part.etag));
}
