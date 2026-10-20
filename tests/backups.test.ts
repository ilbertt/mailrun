import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { fixture } from "./fixtures";
import { BACKUP_TABLES, coveredTables, restoreBackup, writeBackup } from "../src/lib/backups/export";
import { getMigrations } from "../src/server/assets";
import { migrate } from "../src/server/db";

test("new tables are covered once; leases are excluded; old full backups restore before and after migration", async () => {
	const state = await fixture();
	const legacyPath = join(state.directory, "legacy.sqlite");
	const legacy = new Database(legacyPath);
	try {
		for (const [name, file] of getMigrations()) if (name.endsWith(".sql") && !name.startsWith("0062")) legacy.exec(await file.text());
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
		expect(state.db.query("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'searchable'").all()).toHaveLength(1);
	} finally { legacy.close(); await state.close(); }
});
test("malformed restore rolls back without destroying existing messages", async () => {
	const state = await fixture();
	try {
		const tables = Object.fromEntries(BACKUP_TABLES.map(name => [name, name === "messages" ? [{ id: "broken" }] : []]));
		expect(() => restoreBackup(state.db, { format: "mailflare-database-backup", version: 1, createdAt: "", tables })).toThrow();
		expect(state.db.query("SELECT id FROM messages").all()).toHaveLength(1);
		await migrate(state.path);
		expect(state.db.query("SELECT id FROM messages").all()).toHaveLength(1);
	} finally { await state.close(); }
});
