import { id } from "../db";
import { LocalStorage } from "../storage";
export const storageStatus = {
	provider: "files",
	configured: true,
	bucket: null,
	endpoint: null,
};
export async function v1StorageTest() {
	const storage = new LocalStorage(),
		key = `healthcheck/${id("chk")}`,
		payload = `mailflare ${new Date().toISOString()}`,
		start = Date.now();
	try {
		await storage.put(key, payload);
		const value = await storage.file(key).text();
		if (value !== payload)
			throw new Error("Object read back did not match what was written");
		await storage.delete(key);
		return { ok: true, latencyMs: Date.now() - start };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : "Storage test failed",
			latencyMs: Date.now() - start,
		};
	} finally {
		await storage.delete(key).catch(() => {});
	}
}
