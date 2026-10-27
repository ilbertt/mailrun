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
