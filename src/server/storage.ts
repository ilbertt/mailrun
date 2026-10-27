import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { dataDirectory } from "./config";

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
		const temporary = `${path}.${crypto.randomUUID()}.tmp`;
		try {
			await Bun.write(temporary, bytes, { mode: 0o600 });
			await rename(temporary, path);
		} finally {
			await unlink(temporary).catch(() => {});
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
