import { AsyncLocalStorage } from "node:async_hooks";
import { test, expect, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import { join, resolve } from "node:path";
import { readdir } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { fixture, owner, enableTeamSharing } from "./fixtures";
import { upsertContact } from "../src/server/mail/contacts";
import { runAvatarJobs } from "../src/server/avatars/jobs";
import { fetchGravatar } from "../src/server/avatars/gravatar";
import { startAvatarDispatcher } from "../src/server/avatars/dispatcher";
import { imageResponse } from "../src/server/images";
import { avatarsApi } from "../src/server/api/avatars";
import { contactsApi } from "../src/server/api/contacts";
import { LocalStorage } from "../src/server/storage";
import { userMailRevision } from "../src/server/realtime";
import { seconds, migrate } from "../src/server/db";
import { getMigrations } from "../src/server/assets";
import {
	writeBackup,
	restoreBackup,
	coveredTables,
} from "../src/lib/backups/export";
const png = Uint8Array.from(
	Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
		"base64",
	),
);
const webp = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]);
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
const image = () =>
	new Response(png, { headers: { "Content-Type": "image/png" } });
async function contact(email = "sender@example.org", mailboxId = "mailbox") {
	const row = await upsertContact(owner.id, email, "inbound", mailboxId);
	if (!row) throw new Error("Contact missing");
	return row;
}
async function saved(email = "sender@example.org") {
	return z
		.object({ id: z.string(), avatar_key: z.string().nullable() })
		.parse(
			state.db
				.query("SELECT id,avatar_key FROM contacts WHERE user_id=? AND email=?")
				.get(owner.id, email),
		);
}
async function files(path = join(state.directory, "blobs")): Promise<string[]> {
	const result: string[] = [];
	for (const item of await readdir(path, { withFileTypes: true }).catch(
		() => [],
	)) {
		const next = join(path, item.name);
		if (item.isDirectory()) result.push(...(await files(next)));
		else result.push(next);
	}
	return result;
}
function avatarRequest(method: string) {
	return new Request(
		"http://localhost:3000/api/contacts/avatar?mailboxId=mailbox&address=sender%40example.org",
		{ method },
	);
}

test("new contacts queue one import; retrieval normalizes SHA-256 URLs and stores a full image and preview", async () => {
	const row = await contact("Sender <SENDER@example.org>");
	expect(row.avatar_key).toBeNull();
	expect(
		state.db.query("SELECT status FROM mailrun_contact_avatar_jobs").get(),
	).toEqual({ status: "pending" });
	const calls: string[] = [];
	expect(
		await runAvatarJobs(async (input) => {
			calls.push(String(input));
			return image();
		}),
	).toBe(1);
	const hash = new Bun.CryptoHasher("sha256")
		.update("sender@example.org")
		.digest("hex");
	expect(calls).toEqual([
		`https://gravatar.com/avatar/${hash}?d=404&r=g&s=256`,
		`https://gravatar.com/avatar/${hash}?d=404&r=g&s=16`,
	]);
	const record = await saved();
	expect(record.avatar_key).not.toBeNull();
	const response = await imageResponse(
		new Request("http://localhost:3000/avatar?v=1"),
		record.avatar_key!,
	);
	expect(response.headers.get("Content-Type")).toBe("image/png");
	expect(response.headers.get("Cache-Control")).toBe(
		"private, max-age=31536000, immutable",
	);
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
	const preview = await imageResponse(
		new Request("http://localhost:3000/avatar?variant=preview"),
		record.avatar_key!,
	);
	expect(preview.status).toBe(200);
	await contact();
	expect(
		await runAvatarJobs(async () => {
			throw new Error("An existing contact was fetched twice");
		}),
	).toBe(0);
});
test("contacts that already existed before the migration are not unexpectedly imported", async () => {
	state.db.exec(
		"INSERT INTO contacts(id,user_id,email,source,last_seen_at,created_at) VALUES('legacy','owner','legacy@example.org','inbound',1,1)",
	);
	await upsertContact(owner.id, "legacy@example.org", "outbound", "mailbox");
	expect(
		state.db.query("SELECT contact_id FROM mailrun_contact_avatar_jobs").all(),
	).toHaveLength(0);
});
test("blocking a new contact queues its source avatar without performing network work inside the contact transaction", async () => {
	const response = await contactsApi(
		new Request("http://localhost:3000/api/contacts/block", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				mailboxId: "mailbox",
				address: "blocked@example.org",
			}),
		}),
		owner,
	);
	expect(response?.status).toBe(200);
	expect(
		state.db.query("SELECT status FROM mailrun_contact_avatar_jobs").all(),
	).toEqual([{ status: "pending" }]);
	expect(await runAvatarJobs(async () => image())).toBe(1);
});
test("preview failure keeps the full image and conditional retrieval intact", async () => {
	await contact();
	await runAvatarJobs(async (input) =>
		String(input).includes("s=16")
			? new Response(null, { status: 404 })
			: image(),
	);
	const record = await saved();
	const full = await imageResponse(
		new Request("http://localhost:3000/avatar"),
		record.avatar_key!,
	);
	const etag = full.headers.get("ETag")!;
	await full.body?.cancel();
	const cached = await imageResponse(
		new Request("http://localhost:3000/avatar", {
			headers: { "If-None-Match": etag },
		}),
		record.avatar_key!,
	);
	expect(cached.status).toBe(304);
	expect(cached.body).toBeNull();
	expect(
		(
			await imageResponse(
				new Request("http://localhost:3000/avatar?variant=preview"),
				record.avatar_key!,
			)
		).status,
	).toBe(404);
});
test("invalid image types, mismatched magic bytes and oversized bodies do not publish avatars", async () => {
	for (const response of [
		new Response("<script/>", { headers: { "Content-Type": "image/svg+xml" } }),
		new Response("<html/>", { headers: { "Content-Type": "image/png" } }),
		new Response(png, {
			headers: {
				"Content-Type": "image/png",
				"Content-Length": String(2 * 1024 * 1024 + 1),
			},
		}),
		new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
			headers: { "Content-Type": "image/png" },
		}),
	]) {
		expect(
			await fetchGravatar(
				owner.id,
				"sender@example.org",
				crypto.randomUUID(),
				async () => response,
			),
		).toBeNull();
	}
	expect(await files()).toHaveLength(0);
});
test("only HTTPS Gravatar redirects are followed, without leaking application credentials", async () => {
	let count = 0;
	const key = await fetchGravatar(
		owner.id,
		"sender@example.org",
		"redirect-fixture",
		async (input, init) => {
			expect(new Headers(init?.headers).has("Authorization")).toBe(false);
			if (++count === 1)
				return new Response(null, {
					status: 302,
					headers: { Location: "https://secure.gravatar.com/avatar/fixture" },
				});
			expect(
				new URL(input instanceof Request ? input.url : String(input)).hostname,
			).toBe("secure.gravatar.com");
			return image();
		},
	);
	expect(key).not.toBeNull();
	expect(
		await fetchGravatar(
			owner.id,
			"other@example.org",
			"bad-redirect",
			async () =>
				new Response(null, {
					status: 302,
					headers: { Location: "https://foreign.example/private" },
				}),
		),
	).toBeNull();
});
test("an uploaded avatar wins over an in-flight automatic import", async () => {
	await contact();
	let entered = () => {},
		release = () => {};
	const ready = new Promise<void>((resolve) => {
			entered = resolve;
		}),
		gate = new Promise<void>((resolve) => {
			release = resolve;
		});
	const running = runAvatarJobs(async (input) => {
		if (String(input).includes("s=256")) {
			entered();
			await gate;
		}
		return image();
	});
	await ready;
	const form = new FormData();
	form.set("mailboxId", "mailbox");
	form.set("address", "sender@example.org");
	form.set("file", new File([webp], "avatar.webp", { type: "image/webp" }));
	form.set("preview", new File([webp], "preview.webp", { type: "image/webp" }));
	try {
		expect(
			(
				await avatarsApi(
					new Request("http://localhost:3000/api/contacts/avatar", {
						method: "POST",
						body: form,
					}),
					owner,
				)
			)?.status,
		).toBe(200);
	} finally {
		release();
		await running;
	}
	const record = await saved();
	expect(record.avatar_key).toStartWith("avatars/contacts/");
	expect(
		(await files()).filter((path) => path.includes("contact-avatars/")),
	).toHaveLength(0);
	expect(
		(
			await imageResponse(
				new Request("http://localhost:3000/avatar"),
				record.avatar_key!,
			)
		).headers.get("Content-Type"),
	).toBe("image/webp");
});
test("deleting an avatar cancels an in-flight import even when the stored key is still null", async () => {
	await contact();
	let entered = () => {},
		release = () => {};
	const ready = new Promise<void>((resolve) => {
			entered = resolve;
		}),
		gate = new Promise<void>((resolve) => {
			release = resolve;
		});
	const running = runAvatarJobs(async () => {
		entered();
		await gate;
		return image();
	});
	await ready;
	try {
		expect((await avatarsApi(avatarRequest("DELETE"), owner))?.status).toBe(
			200,
		);
	} finally {
		release();
		await running;
	}
	expect((await saved()).avatar_key).toBeNull();
	expect(await files()).toHaveLength(0);
});
test("a replaced lease cannot publish bytes or overwrite the replacement worker state", async () => {
	const row = await contact();
	let entered = () => {},
		release = () => {};
	const ready = new Promise<void>((resolve) => {
			entered = resolve;
		}),
		gate = new Promise<void>((resolve) => {
			release = resolve;
		});
	const running = runAvatarJobs(async () => {
		entered();
		await gate;
		return image();
	});
	await ready;
	state.db
		.query(
			"UPDATE mailrun_contact_avatar_jobs SET owner='replacement',lease_until=? WHERE contact_id=?",
		)
		.run(seconds() + 60, row.id);
	release();
	await running;
	expect((await saved()).avatar_key).toBeNull();
	expect(await files()).toHaveLength(0);
	expect(
		state.db
			.query("SELECT owner,status FROM mailrun_contact_avatar_jobs")
			.get(),
	).toEqual({ owner: "replacement", status: "running" });
});
test("graceful shutdown leaves the claimed import pending for recovery", async () => {
	await contact();
	let entered = () => {};
	const ready = new Promise<void>((resolve) => {
			entered = resolve;
		}),
		controller = new AbortController();
	const running = runAvatarJobs(async (_input, init) => {
		entered();
		return new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener(
				"abort",
				() => reject(init.signal?.reason),
				{ once: true },
			);
		});
	}, controller.signal);
	await ready;
	controller.abort();
	await running;
	expect(
		state.db
			.query("SELECT status,owner FROM mailrun_contact_avatar_jobs")
			.get(),
	).toEqual({ status: "pending", owner: null });
	expect(await runAvatarJobs(async () => image())).toBe(1);
});
test("disabled account work is not fetched and revocation before publication prevents an update", async () => {
	await contact();
	state.db.exec("UPDATE users SET disabled=1 WHERE id='owner'");
	expect(
		await runAvatarJobs(async () => {
			throw new Error("Disabled account fetched");
		}),
	).toBe(0);
	state.db.exec("UPDATE users SET disabled=0 WHERE id='owner'");
	await runAvatarJobs(async () => {
		state.db.exec("UPDATE users SET disabled=1 WHERE id='owner'");
		return image();
	});
	expect((await saved()).avatar_key).toBeNull();
	expect(await files()).toHaveLength(0);
});
test("mailbox refresh revisions change only for the contact scopes a shared reader can access", async () => {
	enableTeamSharing(state.db);
	state.db.exec(
		"INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES('share','mailbox','stranger','read_only',1); INSERT INTO mailboxes(id,user_id,domain_id,local_part,created_at) VALUES('private','owner','domain','private',2)",
	);
	const before = await userMailRevision("stranger");
	await contact("private@example.org", "private");
	await runAvatarJobs(async () => image());
	expect(await userMailRevision("stranger")).toBe(before);
	await contact("shared@example.org", "mailbox");
	await runAvatarJobs(async () => image());
	expect(await userMailRevision("stranger")).not.toBe(before);
});
test("the eager dispatcher runs outside request context and recovers pending imports", async () => {
	const context = new AsyncLocalStorage<string>();
	let seen: string | undefined = "not-called";
	const stop = startAvatarDispatcher(async () => {
		seen = context.getStore();
		return image();
	});
	try {
		await context.run("request", () => contact());
		const deadline = Date.now() + 2000;
		while (Date.now() < deadline) {
			const row = z
				.object({ status: z.string() })
				.parse(
					state.db
						.query("SELECT status FROM mailrun_contact_avatar_jobs")
						.get(),
				);
			if (row.status === "complete") break;
			await Bun.sleep(10);
		}
		expect(seen).toBeUndefined();
		expect(
			state.db.query("SELECT status FROM mailrun_contact_avatar_jobs").get(),
		).toEqual({ status: "complete" });
	} finally {
		await stop();
	}
});

test("independent main/cron processes claim the same avatar import only once", async () => {
	await contact();
	const marker = join(state.directory, "fetches.txt"),
		module = resolve("src/server/avatars/jobs.ts"),
		code = `import {runAvatarJobs} from ${JSON.stringify(module)};import {appendFile} from 'node:fs/promises';console.log(await runAvatarJobs(async()=>{await appendFile(${JSON.stringify(marker)},'fetch\\n');return new Response(Uint8Array.from(${JSON.stringify([...png])}),{headers:{'Content-Type':'image/png'}});}));`;
	const children = [0, 1].map(() =>
		Bun.spawn([process.execPath, "-e", code], {
			env: { ...process.env, DATA_DIR: state.directory },
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
	const results = await Promise.all(
		children.map(async (child) => {
			const [out, error, exit] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(error).toBe("");
			expect(exit).toBe(0);
			return Number(out.trim());
		}),
	);
	expect(results.reduce((sum, value) => sum + value, 0)).toBe(1);
	expect((await Bun.file(marker).text()).split("fetch").length - 1).toBe(2);
});
test("avatar jobs are backed up once; derived refresh ticks are excluded; older full backups restore across migration 0067", async () => {
	const legacyPath = join(state.directory, "before-avatar.sqlite"),
		legacy = new Database(legacyPath);
	legacy.exec(
		"CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TEXT DEFAULT CURRENT_TIMESTAMP)",
	);
	try {
		for (const [name, file] of getMigrations())
			if (name.endsWith(".sql") && name.slice(0, 4) < "0067") {
				legacy.exec(await file.text());
				legacy.query("INSERT INTO d1_migrations(name) VALUES(?)").run(name);
			}
		const empty = join(state.directory, "avatar-empty.json");
		await writeBackup(state.path, empty);
		restoreBackup(legacy, await Bun.file(empty).json());
		const old = join(state.directory, "avatar-old.json");
		await writeBackup(legacyPath, old);
		restoreBackup(legacy, await Bun.file(old).json());
		await contact();
		const current = join(state.directory, "avatar-current.json");
		await writeBackup(state.path, current);
		const backup = await Bun.file(current).json();
		expect(backup.tables.mailrun_contact_avatar_jobs).toHaveLength(1);
		expect(backup.tables.mailrun_contact_avatar_revisions).toBeUndefined();
		expect(() => restoreBackup(legacy, backup)).toThrow(
			"Apply migrations before restoring mailrun_contact_avatar_jobs",
		);
		await migrate(legacyPath);
		restoreBackup(legacy, backup);
		expect(
			coveredTables(legacy).filter(
				(name) => name === "mailrun_contact_avatar_jobs",
			),
		).toHaveLength(1);
		expect(legacy.query("PRAGMA foreign_key_check").all()).toEqual([]);
		restoreBackup(legacy, await Bun.file(old).json());
		expect(
			legacy.query("SELECT contact_id FROM mailrun_contact_avatar_jobs").all(),
		).toHaveLength(0);
	} finally {
		legacy.close();
	}
});
