import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { fixture } from "./fixtures";
import { getMigrations } from "../src/server/assets";
import { migrate } from "../src/server/db";
import {
	BACKUP_TABLES,
	INTERNAL_TABLES,
	coveredTables,
	restoreBackup,
	writeBackup,
} from "../src/lib/backups/export";
import { BACKUP_TABLE_GROUPS } from "../src/lib/backups/table-groups";
test("protocol draft intent is backed up exactly once and older full documents restore before and after 0071", async () => {
	const state = await fixture(),
		path = join(state.directory, "before-0071.sqlite"),
		old = new Database(path);
	try {
		old.exec(
			"PRAGMA foreign_keys=ON;CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TEXT DEFAULT CURRENT_TIMESTAMP)",
		);
		for (const [name, file] of getMigrations())
			if (name.endsWith(".sql") && name.slice(0, 4) < "0071") {
				old.exec(await file.text());
				old.query("INSERT INTO d1_migrations(name) VALUES(?)").run(name);
			}
		const seed = join(state.directory, "seed.json");
		await writeBackup(state.path, seed);
		restoreBackup(old, await Bun.file(seed).json());
		expect(coveredTables(old)).not.toContain("mailrun_submission_drafts");
		old.exec(
			"INSERT INTO outbound_jobs(id,user_id,message_id,status,payload,created_at,updated_at) VALUES('submission','owner','message','queued','{}',1,1)",
		);
		const before = join(state.directory, "old.json");
		await writeBackup(path, before);
		const document: unknown = await Bun.file(before).json();
		restoreBackup(old, document);
		await migrate(path);
		restoreBackup(old, document);
		expect(old.query("SELECT * FROM mailrun_submission_drafts").all()).toEqual(
			[],
		);
		old.exec(
			"INSERT INTO mailrun_submission_drafts(job_id,draft_id,draft_revision) VALUES('submission','message',7)",
		);
		const native = join(state.directory, "native.json");
		await writeBackup(path, native);
		restoreBackup(state.db, await Bun.file(native).json());
		const expected = [
			{ job_id: "submission", draft_id: "message", draft_revision: 7 },
		];
		expect(
			state.db.query("SELECT * FROM mailrun_submission_drafts").all(),
		).toEqual(expected);
		state.db.exec("DELETE FROM messages WHERE id='message'");
		expect(
			state.db.query("SELECT * FROM mailrun_submission_drafts").all(),
		).toEqual(expected);
		await writeBackup(state.path, native);
		restoreBackup(old, await Bun.file(native).json());
		expect(old.query("SELECT * FROM mailrun_submission_drafts").all()).toEqual(
			expected,
		);
		expect(old.query("PRAGMA foreign_key_check").all()).toEqual([]);
		old.exec("DELETE FROM outbound_jobs WHERE id='submission'");
		expect(old.query("SELECT * FROM mailrun_submission_drafts").all()).toEqual(
			[],
		);
		expect(
			BACKUP_TABLES.filter((table) => table === "mailrun_submission_drafts"),
		).toHaveLength(1);
		expect(BACKUP_TABLES.indexOf("outbound_jobs")).toBeLessThan(
			BACKUP_TABLES.indexOf("mailrun_submission_drafts"),
		);
		expect(
			BACKUP_TABLE_GROUPS.flatMap((group) => group.tables).filter(
				(table) => table === "mailrun_submission_drafts",
			),
		).toHaveLength(1);
		expect(INTERNAL_TABLES).not.toContain("mailrun_submission_drafts");
		expect(coveredTables(state.db)).toContain("mailrun_submission_drafts");
	} finally {
		old.close();
		await state.close();
	}
});
