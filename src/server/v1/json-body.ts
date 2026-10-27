import { mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { id } from "../db";
import { LocalStorage } from "../storage";
import { readLimitedBody } from "../mail/inbound";
/** Large base64 JSON must not coexist with several copies of its wire bytes. */
export async function readPublicSendBody(request: Request): Promise<unknown> {
	const limit = 40 * 1024 * 1024,
		length = Number(request.headers.get("content-length") ?? 0);
	if (length > limit) throw new Error("Message too large");
	if (length > 0 && length <= 512 * 1024)
		return JSON.parse(
			new TextDecoder().decode(await readLimitedBody(request, limit)),
		);
	const path = new LocalStorage().path(`import-staging/${id("api-body")}.json`);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	try {
		await Bun.write(path, "", { mode: 0o600 });
		await (async () => {
			const writer = Bun.file(path).writer({ highWaterMark: 1024 * 1024 }),
				reader = request.body?.getReader();
			let size = 0,
				pending = 0;
			try {
				if (reader)
					while (true) {
						const chunk = await reader.read();
						if (chunk.done) break;
						size += chunk.value.length;
						if (size > limit) {
							await reader.cancel();
							throw new Error("Message too large");
						}
						const wrote = writer.write(chunk.value);
						if (typeof wrote !== "number") await wrote;
						pending += chunk.value.length;
						if (pending >= 1024 * 1024) {
							await writer.flush();
							pending = 0;
						}
					}
			} finally {
				reader?.releaseLock();
				await writer.end();
			}
		})();
		Bun.gc(true);
		const value: unknown = await Bun.file(path).json();
		Bun.gc(true);
		return value;
	} finally {
		await unlink(path).catch(() => {});
	}
}
