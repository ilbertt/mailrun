import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { dataDirectory } from "./config";

export class LocalStorage {
	constructor(readonly root = join(dataDirectory(), "blobs")) {}
	path(key: string) {
		if (!key || key.includes("\\") || key.includes("\0") || key.split("/").some(part => part === "." || part === "..")) throw new Error("Invalid object key");
		const root = resolve(this.root);
		const path = resolve(root, key);
		if (!path.startsWith(root + sep)) throw new Error("Invalid object key");
		return path;
	}
	async put(key: string, bytes: Uint8Array | ArrayBuffer | string) {
		const path = this.path(key);
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		const temporary = `${path}.${crypto.randomUUID()}.tmp`;
		try {
			await Bun.write(temporary, bytes, { mode: 0o600 });
			await rename(temporary, path);
		} finally { await unlink(temporary).catch(() => {}); }
	}
	file(key: string) { return Bun.file(this.path(key)); }
	async delete(key: string) { await unlink(this.path(key)).catch(error => { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }); }
}
