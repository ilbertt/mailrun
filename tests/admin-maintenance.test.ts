import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, owner, stranger } from "./fixtures";
import { getMigrations } from "../src/server/assets";
import {
	applyPendingMigrations,
	getMigrationStatus,
	withDatabase,
} from "../src/server/db";
import { adminMaintenanceApi } from "../src/server/api/admin-maintenance";
import { publicOrigin } from "../src/server/config";

const request = (path: string, method = "GET", origin?: string) =>
	new Request(publicOrigin() + "/api/admin/" + path, {
		method,
		headers: origin ? { Origin: origin } : {},
	});
async function legacyDatabase(path: string) {
	const db = new Database(path);
	db.exec(
		"CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)",
	);
	for (const [name, file] of getMigrations()) {
		if (!name.endsWith(".sql") || name.slice(0, 4) >= "0065") continue;
		db.exec(await file.text());
		db.query("INSERT INTO d1_migrations(name) VALUES (?)").run(name);
	}
	return db;
}

test("migration inspection leaves missing and pre-ledger databases untouched", async () => {
	const state = await fixture();
	try {
		const path = join(state.directory, "uninitialized.sqlite");
		const empty = await getMigrationStatus(path);
		expect(empty.ready).toBe(false);
		expect(empty.pending.length).toBeGreaterThan(60);
		expect(existsSync(path)).toBe(false);
		const db = new Database(path);
		try {
			db.exec(
				"CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('preserve')",
			);
			expect(await getMigrationStatus(path)).toEqual(empty);
			expect(
				db.query("SELECT name FROM sqlite_master WHERE type='table'").all(),
			).toEqual([{ name: "sentinel" }]);
		} finally {
			db.close();
		}
	} finally {
		await state.close();
	}
});

test("migration DDL and its ledger entry roll back together and can be retried", async () => {
	const state = await fixture();
	const path = join(state.directory, "legacy.sqlite");
	const db = await legacyDatabase(path);
	try {
		const before = await getMigrationStatus(path);
		expect(before.pending).toEqual(["0065_jmap_uploads.sql"]);
		db.exec(
			"CREATE TRIGGER reject_migration BEFORE INSERT ON d1_migrations BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
		);
		await expect(applyPendingMigrations(path)).rejects.toThrow(
			"synthetic failure",
		);
		expect(await getMigrationStatus(path)).toEqual(before);
		expect(
			db
				.query(
					"SELECT name FROM sqlite_master WHERE name='mailrun_jmap_uploads'",
				)
				.get(),
		).toBeNull();
		db.exec("DROP TRIGGER reject_migration");
		expect(await applyPendingMigrations(path)).toEqual({
			ready: true,
			unknown: [],
			pending: [],
			applied: before.pending,
		});
		expect(await applyPendingMigrations(path)).toEqual({
			ready: true,
			unknown: [],
			pending: [],
			applied: [],
		});
	} finally {
		db.close();
		await state.close();
	}
});

test("unknown migration names prevent every pending schema change", async () => {
	const state = await fixture();
	const path = join(state.directory, "future.sqlite");
	const db = await legacyDatabase(path);
	try {
		db.exec("INSERT INTO d1_migrations(name) VALUES('9999_future.sql')");
		expect(await getMigrationStatus(path)).toMatchObject({
			ready: false,
			unknown: ["9999_future.sql"],
		});
		await expect(applyPendingMigrations(path)).rejects.toThrow(
			"not part of this Mailflare release",
		);
		expect(
			db
				.query(
					"SELECT name FROM sqlite_master WHERE name='mailrun_jmap_uploads'",
				)
				.get(),
		).toBeNull();
	} finally {
		db.close();
		await state.close();
	}
});

test("independent processes applying the same migration each observe one committed upgrade", async () => {
	const state = await fixture();
	const path = join(state.directory, "concurrent.sqlite");
	const db = await legacyDatabase(path);
	try {
		const module = resolve("src/server/db.ts");
		const code = `import { applyPendingMigrations } from ${JSON.stringify(module)}; console.log(JSON.stringify(await applyPendingMigrations(process.argv[1])));`;
		const children = Array.from({ length: 2 }, () =>
			Bun.spawn([process.execPath, "-e", code, path], {
				stdout: "pipe",
				stderr: "pipe",
			}),
		);
		const results = await Promise.all(
			children.map(async (child) => {
				const [out, err, exit] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect(err).toBe("");
				expect(exit).toBe(0);
				return JSON.parse(out) as { ready: boolean; applied: string[] };
			}),
		);
		expect(results.every((r) => r.ready)).toBe(true);
		expect(results.flatMap((r) => r.applied)).toEqual([
			"0065_jmap_uploads.sql",
		]);
	} finally {
		db.close();
		await state.close();
	}
});

test("applying migrations waits for in-process async database callbacks", async () => {
	const state = await fixture();
	let release = () => {};
	let entered = () => {};
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const ready = new Promise<void>((r) => {
		entered = r;
	});
	try {
		const writer = withDatabase(async (sql) =>
			sql.begin(async () => {
				entered();
				await gate;
			}),
		);
		await ready;
		let migrated = false;
		const migration = applyPendingMigrations().then(() => {
			migrated = true;
		});
		try {
			await Bun.sleep(20);
			expect(migrated).toBe(false);
		} finally {
			release();
			await Promise.all([writer, migration]);
		}
		expect(migrated).toBe(true);
	} finally {
		release();
		await state.close();
	}
});

test("maintenance permissions use live roles; migration POST requires the exact public origin", async () => {
	const state = await fixture();
	try {
		for (const path of ["update", "migrations", "search-index"])
			await expect(
				adminMaintenanceApi(request(path), stranger),
			).rejects.toMatchObject({ status: 403 });
		state.db.exec("UPDATE users SET role='admin' WHERE id='stranger'");
		for (const path of ["update", "migrations"])
			await expect(
				adminMaintenanceApi(request(path), {
					...stranger,
					role: "admin",
					isPrimaryAdmin: true,
				}),
			).rejects.toMatchObject({ status: 403 });
		expect(
			(await adminMaintenanceApi(request("search-index"), stranger))?.status,
		).toBe(200);
		for (const origin of [undefined, "https://foreign.example"])
			expect(
				(
					await adminMaintenanceApi(
						request("migrations", "POST", origin),
						owner,
					)
				)?.status,
			).toBe(403);
		expect(
			await (
				await adminMaintenanceApi(
					request("migrations", "POST", publicOrigin()),
					owner,
				)
			)?.json(),
		).toEqual({ ready: true, pending: [], unknown: [], applied: [] });
		expect(
			await (await adminMaintenanceApi(request("update"), owner))?.json(),
		).toMatchObject({ configured: false, configuration: [] });
		expect(
			(await adminMaintenanceApi(request("update", "POST"), owner))?.status,
		).toBe(400);
		const invalid = await adminMaintenanceApi(
			request("migrations", "DELETE"),
			owner,
		);
		expect(invalid?.status).toBe(405);
		expect(invalid?.headers.get("Allow")).toBe("GET, POST");
		state.db.exec("UPDATE users SET disabled=1 WHERE id='owner'");
		await expect(
			adminMaintenanceApi(request("update"), owner),
		).rejects.toMatchObject({ status: 403 });
	} finally {
		await state.close();
	}
});

test("search-index rebuild restores postings, preserving mail rows and delegated admin access", async () => {
	const state = await fixture();
	try {
		state.db.exec(
			"UPDATE users SET role='admin' WHERE id='stranger'; INSERT INTO messages_fts(messages_fts) VALUES('delete-all')",
		);
		const hits = () =>
			state.db
				.query(
					"SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'searchable'",
				)
				.all();
		expect(hits()).toEqual([]);
		const response = await adminMaintenanceApi(
			request("search-index", "POST"),
			stranger,
		);
		expect(await response?.json()).toEqual({ indexed: 1, messages: 1 });
		expect(hits()).toHaveLength(1);
		expect(
			state.db.query("SELECT subject FROM messages WHERE id='message'").get(),
		).toEqual({ subject: "A searchable subject" });
	} finally {
		await state.close();
	}
});
