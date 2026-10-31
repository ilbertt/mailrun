import { Database } from "bun:sqlite";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	opendir,
	realpath,
	rename,
	rm,
	rmdir,
	stat,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { restoreBackup } from "../../lib/backups/export";
import { migrate, withDatabase } from "../db";
import { LocalStorage } from "../storage";
import { syncDirectory } from "../filesystem";
import {
	sourceDriveUploadId,
	sourceDriveMetadataKey,
	sourceDriveMetadataSchema,
} from "./restore-objects";

const metadataSchema = z.object({
	httpMetadata: z.object({ contentType: z.string().optional() }).optional(),
	customMetadata: z.record(z.string(), z.string()).optional(),
	size: z.number().int().nonnegative().optional(),
	uploaded: z.iso.datetime().optional(),
});
type ObjectDigest = { size: number; sha256: string };
export type SourceBucketMigrationReport = {
	format: "mailrun-source-bucket-migration";
	version: 1;
	objects: number;
	bytes: number;
	jmapUploads: number;
	orphanJmapUploads: number;
	driveParts: number;
};

async function* files(root: string, relative = ""): AsyncGenerator<string> {
	const directory = await opendir(join(root, relative));
	for await (const entry of directory) {
		const key = relative ? relative + "/" + entry.name : entry.name;
		if (entry.isSymbolicLink())
			throw new Error("Source bucket contains a symbolic link");
		if (entry.isDirectory()) yield* files(root, key);
		else if (entry.isFile()) yield key;
		else throw new Error("Source bucket contains a non-file entry");
	}
}

async function digest(path: string): Promise<ObjectDigest> {
	const hash = new Bun.CryptoHasher("sha256");
	let size = 0;
	for await (const bytes of Bun.file(path).stream()) {
		hash.update(bytes);
		size += bytes.byteLength;
	}
	return { size, sha256: hash.digest("hex") };
}

/** Validate every ancestor too: an exported object tree must contain no links. */
async function sourceFile(root: string, key: string) {
	const path = new LocalStorage(root).path(key);
	let current = path;
	while (current !== root) {
		const info = await lstat(current);
		if (info.isSymbolicLink())
			throw new Error("Source bucket contains a symbolic link");
		if (current === path && !info.isFile())
			throw new Error("Source object is not a file");
		current = dirname(current);
	}
	return path;
}

async function optionalMetadata(root: string, key: string) {
	try {
		const path = await sourceFile(root, key + ".meta.json");
		if ((await stat(path)).size > 1024 * 1024)
			throw new Error("Source object metadata is too large");
		return { raw: await Bun.file(path).text(), path };
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw error;
	}
}

async function copyVerified(source: string, store: LocalStorage, key: string) {
	const before = await stat(source),
		expected = await digest(source);
	await store.put(key, Bun.file(source));
	const actual = await digest(store.path(key)),
		after = await stat(source);
	if (
		actual.sha256 !== expected.sha256 ||
		actual.size !== expected.size ||
		before.size !== after.size ||
		before.mtimeMs !== after.mtimeMs ||
		before.ino !== after.ino
	)
		throw new Error(
			"Source object changed during migration; stop source writers and retry",
		);
	return expected;
}

/** Restore a frozen full record document and FileBucket export to a NEW data directory. */
export async function migrateSourceBucket(input: {
	backup: string;
	bucket: string;
	destination: string;
}): Promise<SourceBucketMigrationReport> {
	const bucketInfo = await lstat(resolve(input.bucket));
	if (!bucketInfo.isDirectory() || bucketInfo.isSymbolicLink())
		throw new Error("Expected a plain source bucket directory");
	const bucket = await realpath(input.bucket),
		parent = await realpath(dirname(resolve(input.destination))),
		destination = join(parent, basename(resolve(input.destination)));
	if (destination === bucket || destination.startsWith(bucket + sep))
		throw new Error("Migration destination must be outside the source bucket");
	// Exclusive reservation: never overwrite an existing app or a prior output.
	await mkdir(destination, { mode: 0o700 });
	let staging: string | undefined;
	let published = false;
	try {
		staging = await mkdtemp(join(parent, ".mailrun-source-migration-"));
		const path = join(staging, "mailflare.sqlite");
		await migrate(path);
		await chmod(path, 0o600);
		const db = new Database(path);
		try {
			restoreBackup(db, await Bun.file(input.backup).json());
		} finally {
			db.close();
		}
		const store = new LocalStorage(join(staging, "blobs")),
			metadataStore = new LocalStorage(join(staging, "source-object-metadata"));
		const report: SourceBucketMigrationReport = {
			format: "mailrun-source-bucket-migration",
			version: 1,
			objects: 0,
			bytes: 0,
			jmapUploads: 0,
			orphanJmapUploads: 0,
			driveParts: 0,
		};
		for await (const key of files(bucket)) {
			if (key.startsWith(".multipart/")) continue;
			if (key.endsWith(".meta.json")) {
				await sourceFile(bucket, key.slice(0, -10));
				continue;
			}
			const source = await sourceFile(bucket, key),
				copied = await copyVerified(source, store, key);
			report.objects++;
			report.bytes += copied.size;
			const sidecar = await optionalMetadata(bucket, key);
			if (sidecar) await metadataStore.put(key + ".meta.json", sidecar.raw);
			if (!key.startsWith("jmap-uploads/")) continue;
			const match = /^jmap-uploads\/([^/]+)\/([^/]+)$/.exec(key);
			if (!match) throw new Error("Invalid source JMAP upload key");
			const userId = match[1]!,
				uploadId = match[2]!,
				metadata = sidecar
					? metadataSchema.parse(JSON.parse(sidecar.raw))
					: undefined;
			if (metadata?.size !== undefined && metadata.size !== copied.size)
				throw new Error("Source JMAP upload metadata size mismatch");
			const created = metadata?.uploaded
				? new Date(metadata.uploaded).getTime()
				: (await stat(source)).mtimeMs;
			const imported = await withDatabase(async (sql) => {
				const [user] =
					await sql.NativeSourceUploadOwner`SELECT id FROM users WHERE id=${userId}`;
				if (!user) return false;
				// Ownership follows the source key namespace, never custom userId metadata.
				await sql.NativeSourceUploadMetadata`INSERT INTO mailrun_jmap_uploads(id,user_id,r2_key,content_type,name,size,created_at) VALUES(${uploadId},${userId},${key},${metadata?.httpMetadata?.contentType ?? "application/octet-stream"},${metadata?.customMetadata?.name ?? null},${copied.size},${Math.floor(created / 1000)})`;
				return true;
			}, path);
			if (imported) report.jmapUploads++;
			else report.orphanJmapUploads++;
		}
		const pending = await withDatabase(
			(sql) =>
				sql.NativeSourceDriveUploads`SELECT id,owner_id,r2_key,upload_id,upload_part_size,size FROM drive_items WHERE upload_id IS NOT NULL`,
			path,
		);
		for (const item of pending) {
			if (
				!item.upload_id ||
				!/^[\w-]+$/.test(item.upload_id) ||
				!item.upload_part_size ||
				item.upload_part_size < 1
			)
				throw new Error("Invalid source Drive multipart metadata");
			const nativeUploadId = sourceDriveUploadId(item.id, item.upload_id);
			const translated: {
				number: number;
				sourceEtag: string;
				sha256: string;
			}[] = [];
			const parts = await withDatabase(
				(sql) =>
					sql.NativeSourceDriveParts`SELECT part_number,etag FROM drive_upload_parts WHERE item_id=${item.id} ORDER BY part_number`,
				path,
			);
			for (const part of parts) {
				if (
					!Number.isInteger(part.part_number) ||
					part.part_number < 1 ||
					part.part_number > Math.ceil(item.size / item.upload_part_size)
				)
					throw new Error("Invalid source Drive part number");
				const source = await sourceFile(
						bucket,
						`.multipart/${item.upload_id}/part-${part.part_number}`,
					),
					hash = await digest(source),
					expected = Math.min(
						item.upload_part_size,
						item.size - (part.part_number - 1) * item.upload_part_size,
					);
				if (hash.size !== expected)
					throw new Error("Source Drive part size mismatch");
				const key = `drive-uploads/${encodeURIComponent(item.id)}/${nativeUploadId}/${part.part_number}-${hash.sha256}`;
				const copied = await copyVerified(source, store, key);
				if (copied.sha256 !== hash.sha256)
					throw new Error("Source Drive part changed during migration");
				await withDatabase(
					(sql) =>
						sql.NativeSourceDrivePartHash`UPDATE drive_upload_parts SET etag=${hash.sha256} WHERE item_id=${item.id} AND part_number=${part.part_number} AND etag=${part.etag}`,
					path,
				);
				translated.push({
					number: part.part_number,
					sourceEtag: part.etag,
					sha256: hash.sha256,
				});
				report.driveParts++;
				report.bytes += copied.size;
			}
			await withDatabase(
				(sql) =>
					sql.NativeSourceDriveUploadId`UPDATE drive_items SET upload_id=${nativeUploadId} WHERE id=${item.id} AND upload_id=${item.upload_id}`,
				path,
			);
			await store.put(
				sourceDriveMetadataKey(item.id, item.upload_id),
				JSON.stringify(
					sourceDriveMetadataSchema.parse({
						format: "mailrun-source-drive-upload",
						version: 1,
						itemId: item.id,
						ownerId: item.owner_id,
						sourceId: item.upload_id,
						size: item.size,
						partSize: item.upload_part_size,
						r2Key: item.r2_key,
						parts: translated,
					}),
				),
			);
		}
		const referenced = await withDatabase(
			(sql) =>
				sql.NativeSourceObjectReferences`SELECT raw_r2_key AS object_key FROM messages WHERE raw_r2_key IS NOT NULL UNION SELECT r2_key FROM message_attachments UNION SELECT r2_key FROM drive_items WHERE r2_key IS NOT NULL AND upload_id IS NULL UNION SELECT r2_key FROM backups WHERE r2_key IS NOT NULL AND status='completed' UNION SELECT avatar_key FROM users WHERE avatar_key IS NOT NULL UNION SELECT avatar_key FROM mailboxes WHERE avatar_key IS NOT NULL UNION SELECT avatar_key FROM contacts WHERE avatar_key IS NOT NULL UNION SELECT icon_key FROM app_settings WHERE icon_key IS NOT NULL UNION SELECT r2_key FROM mailrun_jmap_uploads`,
			path,
		);
		for (const row of referenced)
			if (!row.object_key || !(await store.file(row.object_key).exists()))
				throw new Error("Source export is missing a referenced object");
		const final = new Database(path);
		try {
			if (final.query("PRAGMA foreign_key_check").all().length)
				throw new Error("Migrated database has invalid foreign keys");
			const integrity = z
				.object({ integrity_check: z.literal("ok") })
				.safeParse(final.query("PRAGMA integrity_check").get());
			if (!integrity.success)
				throw new Error("Migrated database integrity check failed");
			final.exec("PRAGMA synchronous=FULL; PRAGMA wal_checkpoint(TRUNCATE)");
		} finally {
			final.close();
		}
		await new LocalStorage(staging).put(
			"source-migration-report.json",
			JSON.stringify(report, null, 2) + "\n",
		);
		await syncDirectory(staging);
		await rename(staging, destination);
		published = true;
		await syncDirectory(parent);
		return report;
	} finally {
		if (!published) {
			if (staging) await rm(staging, { recursive: true, force: true });
			// Only remove our empty reservation. Never delete another writer's files.
			await rmdir(destination).catch(() => {});
		}
	}
}
