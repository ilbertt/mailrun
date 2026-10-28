import { mkdir, rm, readdir, open } from "node:fs/promises";
import { join } from "node:path";
import { dataDirectory } from "../config";
declare global {
	var __mailrunSendStageOwner: string | undefined;
}
const owner = (globalThis.__mailrunSendStageOwner ??= crypto.randomUUID());
const root = () => join(dataDirectory(), "sending-staging");
export async function stageSendBody(chunks: AsyncGenerator<Uint8Array>) {
	const directory = join(root(), `${process.pid}-${owner}`),
		path = join(directory, crypto.randomUUID() + ".json"),
		hash = new Bun.CryptoHasher("sha256");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const handle = await open(path, "wx", 0o600);
	try {
		for await (const chunk of chunks) {
			hash.update(chunk);
			let offset = 0;
			while (offset < chunk.length) {
				const { bytesWritten } = await handle.write(
					chunk,
					offset,
					chunk.length - offset,
				);
				if (!bytesWritten) throw new Error("Could not stage outbound mail");
				offset += bytesWritten;
			}
		}
		await handle.close();
		return {
			file: Bun.file(path),
			payloadHash: hash.digest("hex"),
			close: () => rm(path, { force: true }),
		};
	} catch (error) {
		await handle.close().catch(() => undefined);
		await rm(path, { force: true });
		throw error;
	}
}
export async function clearSendingStaging() {
	const directory = root();
	for (const entry of await readdir(directory, { withFileTypes: true }).catch(
		() => [],
	)) {
		if (!entry.isDirectory()) continue;
		const match = /^(\d+)-([a-f0-9-]{36})$/.exec(entry.name);
		if (!match) continue;
		const pid = Number(match[1]);
		if (!Number.isSafeInteger(pid) || pid < 1) continue;
		if (pid === process.pid && match[2] === owner) continue;
		if (pid !== process.pid) {
			try {
				process.kill(pid, 0);
				continue;
			} catch (error) {
				if (
					!(error instanceof Error && "code" in error && error.code === "ESRCH")
				)
					continue;
			}
		}
		await rm(join(directory, entry.name), { recursive: true, force: true });
	}
}
