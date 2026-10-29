import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { fixture } from "./fixtures";
import {
	BACKUP_TABLES,
	coveredTables,
	restoreBackup,
	writeBackup,
} from "../src/lib/backups/export";
import { getMigrations } from "../src/server/assets";
import { migrate } from "../src/server/db";
import {
	saveInstallation,
	getInstallation,
} from "../src/server/cloudflare/installation";

test("token and Global API Key record backups preserve credentials across migration 0069", async () => {
	const state = await fixture();
	const legacyPath = join(state.directory, "pre-global-key.sqlite"),
		legacy = new Database(legacyPath);
	try {
		legacy.exec(
			"CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TEXT DEFAULT CURRENT_TIMESTAMP)",
		);
		for (const [name, file] of getMigrations())
			if (name.endsWith(".sql") && name.slice(0, 4) < "0069") {
				legacy.exec(await file.text());
				legacy.query("INSERT INTO d1_migrations(name) VALUES(?)").run(name);
			}
		const seed = join(state.directory, "global-key-seed.json");
		await writeBackup(state.path, seed);
		restoreBackup(legacy, await Bun.file(seed).json());
		legacy.exec(
			"INSERT INTO mailrun_installation(id,account_id,zone_id,hostname,worker_name,public_origin,api_token,relay_secret,relay_version,phase,updated_at) VALUES('primary','account','zone','example.com','relay','https://fixture.example','old-token','fixture-secret','fixture-version','ready',1)",
		);
		const oldPath = join(state.directory, "old-token-backup.json");
		await writeBackup(legacyPath, oldPath);
		const old: unknown = await Bun.file(oldPath).json();
		restoreBackup(legacy, old);
		expect(
			legacy.query("SELECT api_token FROM mailrun_installation").get(),
		).toEqual({ api_token: "old-token" });
		await saveInstallation({
			accountId: "account",
			zoneId: "zone",
			hostname: "example.com",
			workerName: "relay",
			publicOrigin: "https://fixture.example",
			auth: {
				kind: "global-key",
				key: "saved-key",
				email: "owner@example.com",
			},
			relaySecret: "fixture-secret",
			relayVersion: "fixture-version",
		});
		const currentPath = join(state.directory, "global-key-backup.json");
		await writeBackup(state.path, currentPath);
		const current: unknown = await Bun.file(currentPath).json();
		expect(() => restoreBackup(legacy, current)).toThrow(
			"Apply migrations before restoring Cloudflare Global API Key credentials",
		);
		expect(
			legacy.query("SELECT api_token FROM mailrun_installation").get(),
		).toEqual({ api_token: "old-token" });
		await migrate(legacyPath);
		restoreBackup(legacy, current);
		expect(
			legacy
				.query("SELECT api_token,api_key,api_email FROM mailrun_installation")
				.get(),
		).toEqual({
			api_token: "",
			api_key: "saved-key",
			api_email: "owner@example.com",
		});
		restoreBackup(state.db, current);
		expect(await getInstallation()).toMatchObject({
			api_token: "",
			api_key: "saved-key",
			api_email: "owner@example.com",
		});
		restoreBackup(state.db, old);
		expect(await getInstallation()).toMatchObject({
			api_token: "old-token",
			api_key: null,
			api_email: null,
		});
		expect(
			coveredTables(state.db).filter(
				(table) => table === "mailrun_installation",
			),
		).toHaveLength(1);
		expect(state.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
	} finally {
		legacy.close();
		await state.close();
	}
});

test("new tables are covered once; leases are excluded; old full backups restore before and after migration", async () => {
	const state = await fixture();
	const legacyPath = join(state.directory, "legacy.sqlite");
	const legacy = new Database(legacyPath);
	try {
		for (const [name, file] of getMigrations())
			if (name.endsWith(".sql") && name.slice(0, 4) < "0062")
				legacy.exec(await file.text());
		expect(coveredTables(legacy)).not.toContain("mailrun_installation");
		const destination = join(state.directory, "backup.json");
		await writeBackup(state.path, destination);
		const backup: unknown = await Bun.file(destination).json();
		restoreBackup(legacy, backup);
		expect(legacy.query("SELECT id FROM users").all()).toHaveLength(2);
		const oldBackup = join(state.directory, "old-backup.json");
		await writeBackup(legacyPath, oldBackup);
		restoreBackup(state.db, await Bun.file(oldBackup).json());
		expect(coveredTables(state.db)).toContain("mailrun_installation");
		expect(coveredTables(state.db)).not.toContain("mailrun_job_leases");
		expect(
			state.db
				.query(
					"SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'searchable'",
				)
				.all(),
		).toHaveLength(1);
	} finally {
		legacy.close();
		await state.close();
	}
});
test("malformed restore rolls back without destroying existing messages", async () => {
	const state = await fixture();
	try {
		const tables = Object.fromEntries(
			BACKUP_TABLES.map((name) => [
				name,
				name === "messages" ? [{ id: "broken" }] : [],
			]),
		);
		expect(() =>
			restoreBackup(state.db, {
				format: "mailflare-database-backup",
				version: 1,
				createdAt: "",
				tables,
			}),
		).toThrow();
		expect(state.db.query("SELECT id FROM messages").all()).toHaveLength(1);
		await migrate(state.path);
		expect(state.db.query("SELECT id FROM messages").all()).toHaveLength(1);
	} finally {
		await state.close();
	}
});

test("JMAP upload metadata is backed up once and older full backups restore across migration 0065", async () => {
	const state = await fixture();
	const legacyPath = join(state.directory, "pre-jmap.sqlite");
	const legacy = new Database(legacyPath);
	try {
		legacy.exec(
			"CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)",
		);
		for (const [name, file] of getMigrations()) {
			if (!name.endsWith(".sql") || name.slice(0, 4) >= "0065") continue;
			legacy.exec(await file.text());
			legacy.query("INSERT INTO d1_migrations(name) VALUES (?)").run(name);
		}
		const emptyPath = join(state.directory, "empty-upload-backup.json");
		await writeBackup(state.path, emptyPath);
		restoreBackup(legacy, await Bun.file(emptyPath).json());
		expect(coveredTables(legacy)).not.toContain("mailrun_jmap_uploads");
		const oldPath = join(state.directory, "pre-jmap-backup.json");
		await writeBackup(legacyPath, oldPath);
		const oldBackup = await Bun.file(oldPath).json();
		restoreBackup(legacy, oldBackup);
		state.db.exec(
			"INSERT INTO mailrun_jmap_uploads VALUES ('upload','owner','jmap-uploads/owner/upload','message/rfc822','draft.eml',123,1)",
		);
		const fullPath = join(state.directory, "upload-backup.json");
		await writeBackup(state.path, fullPath);
		const full = await Bun.file(fullPath).json();
		expect(full.tables.mailrun_jmap_uploads).toHaveLength(1);
		expect(
			coveredTables(state.db).filter((name) => name === "mailrun_jmap_uploads"),
		).toHaveLength(1);
		expect(() => restoreBackup(legacy, full)).toThrow(
			"Apply migrations before restoring mailrun_jmap_uploads",
		);
		expect(legacy.query("SELECT id FROM messages").all()).toHaveLength(1);
		restoreBackup(state.db, oldBackup);
		expect(
			state.db.query("SELECT * FROM mailrun_jmap_uploads").all(),
		).toHaveLength(0);
		await migrate(legacyPath);
		restoreBackup(legacy, full);
		expect(legacy.query("SELECT id FROM mailrun_jmap_uploads").get()).toEqual({
			id: "upload",
		});
		restoreBackup(legacy, oldBackup);
		expect(
			legacy.query("SELECT * FROM mailrun_jmap_uploads").all(),
		).toHaveLength(0);
		expect(legacy.query("PRAGMA foreign_key_check").all()).toHaveLength(0);
	} finally {
		legacy.close();
		await state.close();
	}
});

test("domain relay columns retain old full backups and backfill only a verified native primary domain", async () => {
	const state = await fixture(),
		legacyPath = join(state.directory, "before-relay-binding.sqlite"),
		legacy = new Database(legacyPath);
	try {
		legacy.exec(
			"CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TEXT DEFAULT CURRENT_TIMESTAMP)",
		);
		for (const [name, file] of getMigrations())
			if (name.endsWith(".sql") && name.slice(0, 4) < "0068") {
				legacy.exec(await file.text());
				legacy.query("INSERT INTO d1_migrations(name) VALUES(?)").run(name);
			}
		const seed = join(state.directory, "binding-seed.json");
		await writeBackup(state.path, seed);
		restoreBackup(legacy, await Bun.file(seed).json());
		legacy.exec(
			"UPDATE domains SET routing_enabled=1; INSERT INTO domains(id,user_id,hostname,zone_id,status,routing_enabled,created_at) VALUES('other-host','owner','sub.example.com','zone','active',1,1); INSERT INTO mailrun_installation(id,account_id,zone_id,hostname,worker_name,public_origin,api_token,relay_secret,relay_version,phase,updated_at) VALUES('primary','account','zone','example.com','native-primary','https://fixture.example','fixture-token','fixture-secret','fixture-version','ready',1)",
		);
		const oldPath = join(state.directory, "old-binding-backup.json");
		await writeBackup(legacyPath, oldPath);
		const old = await Bun.file(oldPath).json();
		restoreBackup(legacy, old);
		await migrate(legacyPath);
		expect(
			legacy
				.query(
					"SELECT id,mailrun_relay_worker_name,mailrun_relay_zone_id FROM domains ORDER BY id",
				)
				.all(),
		).toEqual([
			{
				id: "domain",
				mailrun_relay_worker_name: "native-primary",
				mailrun_relay_zone_id: "zone",
			},
			{
				id: "other-host",
				mailrun_relay_worker_name: null,
				mailrun_relay_zone_id: null,
			},
		]);
		const currentPath = join(state.directory, "current-binding-backup.json");
		await writeBackup(legacyPath, currentPath);
		const current = await Bun.file(currentPath).json();
		restoreBackup(state.db, current);
		expect(
			state.db
				.query(
					"SELECT mailrun_relay_worker_name FROM domains WHERE id='domain'",
				)
				.get(),
		).toEqual({ mailrun_relay_worker_name: "native-primary" });
		restoreBackup(legacy, old);
		expect(
			legacy.query("SELECT mailrun_relay_worker_name FROM domains").all(),
		).toEqual([
			{ mailrun_relay_worker_name: null },
			{ mailrun_relay_worker_name: null },
		]);
		restoreBackup(legacy, current);
		expect(
			coveredTables(legacy).filter((name) => name === "domains"),
		).toHaveLength(1);
		expect(legacy.query("SELECT id FROM messages").all()).toEqual([
			{ id: "message" },
		]);
		expect(legacy.query("PRAGMA foreign_key_check").all()).toEqual([]);
	} finally {
		legacy.close();
		await state.close();
	}
});
