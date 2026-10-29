import { mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { dataDirectory } from "./config";
import { syncDirectory } from "./filesystem";

export class LocalStorage {
	constructor(readonly root = join(dataDirectory(), "blobs")) {}
	path(key: string) {
		if (
			!key ||
			key.includes("\\") ||
			key.includes("\0") ||
			key.split("/").some((part) => part === "." || part === "..")
		)
			throw new Error("Invalid object key");
		const root = resolve(this.root);
		const path = resolve(root, key);
		if (!path.startsWith(root + sep)) throw new Error("Invalid object key");
		return path;
	}
	async put(key: string, bytes: Uint8Array | ArrayBuffer | string | Blob) {
		const path = this.path(key);
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		const temporaryKey = `${key}.${crypto.randomUUID()}.tmp`,
			temporary = this.path(temporaryKey),
			file = await open(temporary, "wx", 0o600);
		try {
			// Keep the writing descriptor open through fsync so a delayed writeback
			// error cannot disappear between closing it and opening a fresh one.
			const written = await Bun.write(Bun.file(file.fd), bytes),
				expected =
					typeof bytes === "string"
						? Buffer.byteLength(bytes)
						: bytes instanceof Blob
							? bytes.size
							: bytes.byteLength;
			if (written !== expected) throw new Error("Incomplete object write");
			await this.publish(temporaryKey, key, file);
		} finally {
			try {
				await file.close();
			} finally {
				await unlink(temporary).catch(() => {});
			}
		}
	}
	async syncFile(file: FileHandle) {
		await file.sync();
	}
	async syncParents(keys: string[], missingOK = false) {
		const boundary = dirname(resolve(this.root)),
			directories = new Set<string>();
		for (const key of keys) {
			let directory = dirname(this.path(key));
			while (directory !== boundary) {
				directories.add(directory);
				directory = dirname(directory);
			}
			directories.add(boundary);
		}
		// Also persist newly created parent directories. Do not cache this across
		// writes: another HTTP/cron process may have removed and recreated a tree.
		for (const directory of [...directories].sort(
			(a, b) => b.length - a.length,
		))
			await syncDirectory(directory, missingOK);
	}
	async publish(stagedKey: string, key: string, writer?: FileHandle) {
		const staged = this.path(stagedKey),
			destination = this.path(key);
		await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
		const file = writer ?? (await open(staged, "r"));
		try {
			await this.syncFile(file);
			await rename(staged, destination);
			await this.syncParents([stagedKey, key]);
		} finally {
			if (!writer) await file.close();
		}
	}
	file(key: string) {
		return Bun.file(this.path(key));
	}
	async delete(key: string) {
		await unlink(this.path(key)).catch((error) => {
			if (
				!(error instanceof Error && "code" in error && error.code === "ENOENT")
			)
				throw error;
		});
		await this.syncParents([key], true);
	}
}

/** A restored backup may contain several rows pointing at the same object. */
export async function deleteUnreferencedObjects(keys: string[]) {
	const { withDatabase } = await import("./db");
	const candidates = [...new Set(keys)];
	if (!candidates.length) return;
	const rows = await withDatabase(
		(sql) =>
			sql.NativeReferencedObjects`WITH candidates AS(SELECT value AS object_key FROM json_each(${JSON.stringify(candidates)})) SELECT object_key FROM candidates WHERE EXISTS(SELECT 1 FROM messages WHERE raw_r2_key=object_key) OR EXISTS(SELECT 1 FROM message_attachments WHERE r2_key=object_key) OR EXISTS(SELECT 1 FROM drive_items WHERE r2_key=object_key) OR EXISTS(SELECT 1 FROM backups WHERE r2_key=object_key) OR EXISTS(SELECT 1 FROM mailrun_jmap_uploads WHERE r2_key=object_key) OR EXISTS(SELECT 1 FROM users WHERE avatar_key=object_key) OR EXISTS(SELECT 1 FROM mailboxes WHERE avatar_key=object_key) OR EXISTS(SELECT 1 FROM contacts WHERE avatar_key=object_key) OR EXISTS(SELECT 1 FROM app_settings WHERE icon_key=object_key)`,
	);
	const referenced = new Set(rows.map((row) => row.object_key));
	await Promise.all(
		candidates
			.filter((key) => !referenced.has(key))
			.map((key) => new LocalStorage().delete(key)),
	);
}
