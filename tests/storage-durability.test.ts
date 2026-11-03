import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readdir, stat, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { z } from "zod";
import { fixture } from "./fixtures";
import { LocalStorage } from "../src/server/storage";
import { removeUploadFiles } from "../src/server/drive/files";
import { withDatabase } from "../src/server/db";
import { storeInbound } from "../src/server/mail/inbound";
import { writeBackup, restoreBackup } from "../src/lib/backups/export";
let state: Awaited<ReturnType<typeof fixture>>;
const resets: (() => void)[] = [];
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	for (const reset of resets.splice(0)) reset();
	await state.close();
});
function diskError() {
	return Object.assign(new Error("Synthetic storage writeback failure"), {
		code: "EIO",
	});
}
async function temporaryFiles(
	path = join(state.directory, "blobs"),
): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await readdir(path, { withFileTypes: true }).catch(
		() => [],
	)) {
		const next = join(path, entry.name);
		if (entry.isDirectory()) result.push(...(await temporaryFiles(next)));
		else if (entry.name.endsWith(".tmp")) result.push(next);
	}
	return result;
}
function barrier() {
	let ready = () => {},
		release = () => {};
	const entered = new Promise<void>((resolve) => {
			ready = resolve;
		}),
		wait = new Promise<void>((resolve) => {
			release = resolve;
		});
	return { ready, release, entered, wait };
}
const raw = new TextEncoder().encode(
	[
		"From: Sender <sender@example.org>",
		"To: hello@example.com",
		"Subject: Durable inbound fixture",
		"Message-ID: <durable-fixture@example.org>",
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="fixture"',
		"",
		"--fixture",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Durable mail body",
		"--fixture",
		"Content-Type: application/octet-stream",
		'Content-Disposition: attachment; filename="fixture.bin"',
		"Content-Transfer-Encoding: base64",
		"",
		"AAECA//+",
		"--fixture--",
		"",
	].join("\r\n"),
);

test("private durable writes retain UTF-8, bytes, Blob and file-backed contents", async () => {
	const storage = new LocalStorage();
	for (const [key, value, expected] of [
		[
			"nested/unicode.txt",
			"mail \u2709\ufe0f",
			new TextEncoder().encode("mail \u2709\ufe0f"),
		],
		["nested/binary", new Uint8Array([0, 1, 255]), new Uint8Array([0, 1, 255])],
		[
			"nested/blob",
			new Blob([new Uint8Array([2, 3, 254])]),
			new Uint8Array([2, 3, 254]),
		],
	] as const) {
		await storage.put(key, value);
		expect(await storage.file(key).bytes()).toEqual(expected);
		expect((await stat(storage.path(key))).mode & 0o777).toBe(0o600);
	}
	await storage.put("copied", storage.file("nested/binary"));
	expect(await storage.file("copied").bytes()).toEqual(
		new Uint8Array([0, 1, 255]),
	);
	expect(
		(await stat(dirname(storage.path("nested/binary")))).mode & 0o777,
	).toBe(0o700);
	expect(await temporaryFiles()).toEqual([]);
});
test("a failed writer flush preserves the prior object and removes its temporary file", async () => {
	const storage = new LocalStorage();
	await storage.put("existing", "old object");
	const mock = spyOn(storage, "syncFile").mockRejectedValue(diskError());
	resets.push(() => mock.mockRestore());
	await expect(storage.put("existing", "replacement")).rejects.toMatchObject({
		code: "EIO",
	});
	expect(await storage.file("existing").text()).toBe("old object");
	expect(await temporaryFiles()).toEqual([]);
});
test("publication cannot resolve before directory durability and never exposes a partial replacement", async () => {
	const storage = new LocalStorage();
	await storage.put("existing", "old object");
	const held = barrier(),
		original = storage.syncParents.bind(storage);
	const mock = spyOn(storage, "syncParents").mockImplementation(
		async (keys) => {
			held.ready();
			await held.wait;
			await original(keys);
		},
	);
	resets.push(() => mock.mockRestore());
	let resolved = false;
	const pending = storage
		.put("existing", new Blob(["complete replacement"]))
		.then(() => {
			resolved = true;
		});
	try {
		await held.entered;
		expect(resolved).toBe(false);
		expect(await storage.file("existing").text()).toBe("complete replacement");
	} finally {
		held.release();
		await pending;
	}
	expect(resolved).toBe(true);
});
for (const failedStage of ["raw", "attachment", "directory"] as const)
	test(`inbound ${failedStage} writeback failure does not commit mail metadata, and retry retains exact bytes`, async () => {
		const storage = new LocalStorage(),
			originalFile = LocalStorage.prototype.syncFile,
			originalParents = LocalStorage.prototype.syncParents;
		let count = 0;
		const fileMock = spyOn(
			LocalStorage.prototype,
			"syncFile",
		).mockImplementation(async function (this: LocalStorage, file) {
			if (
				++count ===
				(failedStage === "raw" ? 1 : failedStage === "attachment" ? 2 : -1)
			)
				throw diskError();
			return originalFile.call(this, file);
		});
		const parentMock = spyOn(
			LocalStorage.prototype,
			"syncParents",
		).mockImplementation(async function (this: LocalStorage, keys) {
			if (failedStage === "directory") throw diskError();
			return originalParents.call(this, keys);
		});
		resets.push(
			() => fileMock.mockRestore(),
			() => parentMock.mockRestore(),
		);
		await expect(
			storeInbound("sender@example.org", "hello@example.com", raw),
		).rejects.toMatchObject({ code: "EIO" });
		expect(
			state.db
				.query(
					"SELECT id FROM messages WHERE subject='Durable inbound fixture'",
				)
				.all(),
		).toHaveLength(0);
		expect(
			state.db.query("SELECT id FROM message_attachments").all(),
		).toHaveLength(0);
		expect(await temporaryFiles()).toEqual([]);
		fileMock.mockRestore();
		parentMock.mockRestore();
		const stored = await storeInbound(
			"sender@example.org",
			"hello@example.com",
			raw,
		);
		if (stored.action !== "store") throw new Error("Expected local intake");
		const message = z
			.object({ raw_r2_key: z.string() })
			.parse(
				state.db
					.query("SELECT raw_r2_key FROM messages WHERE id=?")
					.get(stored.messageId),
			);
		const attachment = z
			.object({ r2_key: z.string() })
			.parse(
				state.db
					.query("SELECT r2_key FROM message_attachments WHERE message_id=?")
					.get(stored.messageId),
			);
		expect(await storage.file(message.raw_r2_key).bytes()).toEqual(raw);
		expect(await storage.file(attachment.r2_key).bytes()).toEqual(
			new Uint8Array([0, 1, 2, 3, 255, 254]),
		);
		expect(
			await storeInbound("sender@example.org", "hello@example.com", raw),
		).toEqual(stored);
		expect(
			state.db
				.query(
					"SELECT id FROM messages WHERE subject='Durable inbound fixture'",
				)
				.all(),
		).toHaveLength(1);
	});
test("inbound does not report success or commit references while the first publication is awaiting directory flush", async () => {
	const held = barrier(),
		original = LocalStorage.prototype.syncParents;
	let first = true,
		settled = false;
	const mock = spyOn(LocalStorage.prototype, "syncParents").mockImplementation(
		async function (this: LocalStorage, keys) {
			if (first) {
				first = false;
				held.ready();
				await held.wait;
			}
			return original.call(this, keys);
		},
	);
	resets.push(() => mock.mockRestore());
	const pending = storeInbound(
		"sender@example.org",
		"hello@example.com",
		raw,
	).then((result) => {
		settled = true;
		return result;
	});
	try {
		await held.entered;
		expect(settled).toBe(false);
		expect(
			state.db
				.query(
					"SELECT id FROM messages WHERE subject='Durable inbound fixture'",
				)
				.all(),
		).toHaveLength(0);
	} finally {
		held.release();
		await pending;
	}
	expect(settled).toBe(true);
});
test("object promotion across directory trees preserves contents and removes only its staged name", async () => {
	const storage = new LocalStorage();
	await storage.put("staged/upload/object", "complete file");
	await storage.publish("staged/upload/object", "files/owner/final");
	expect(await storage.file("files/owner/final").text()).toBe("complete file");
	expect(await storage.file("staged/upload/object").exists()).toBe(false);
	await storage.delete("files/owner/final");
	await storage.delete("files/owner/final");
	expect(await storage.file("files/owner/final").exists()).toBe(false);
});
test("application SQL connections and record restore enforce FULL despite Bun's NORMAL default", async () => {
	const mode = await withDatabase(async (sql) =>
		z
			.array(z.object({ synchronous: z.number() }))
			.parse(await sql`PRAGMA synchronous`),
	);
	expect(mode).toEqual([{ synchronous: 2 }]);
	const path = join(state.directory, "records.json");
	await writeBackup(state.path, path);
	state.db.exec("PRAGMA synchronous=NORMAL");
	restoreBackup(state.db, await Bun.file(path).json());
	expect(state.db.query("PRAGMA synchronous").get()).toEqual({
		synchronous: 2,
	});
});

test("deletion remains idempotent when another cleanup has removed its parent tree", async () => {
	const storage = new LocalStorage();
	await storage.put("temporary/tree/object", "bytes");
	await rm(storage.path("temporary"), { recursive: true });
	await storage.delete("temporary/tree/object");
	await removeUploadFiles("never-uploaded");
	expect(await storage.file("temporary/tree/object").exists()).toBe(false);
});
