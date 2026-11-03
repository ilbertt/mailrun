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
import { z } from "zod";
const snapshotRows = z.array(
	z.object({ job_id: z.string(), message_id: z.string() }),
);
test("transport identity is backed up once and old full documents restore before and after migration 0070", async () => {
	const state = await fixture(),
		path = join(state.directory, "before-0070.sqlite"),
		old = new Database(path);
	try {
		old.exec(
			"CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TEXT DEFAULT CURRENT_TIMESTAMP)",
		);
		for (const [name, file] of getMigrations())
			if (name.endsWith(".sql") && name.slice(0, 4) < "0070") {
				old.exec(await file.text());
				old.query("INSERT INTO d1_migrations(name) VALUES(?)").run(name);
			}
		const seed = join(state.directory, "seed.json");
		await writeBackup(state.path, seed);
		restoreBackup(old, await Bun.file(seed).json());
		old.exec(
			"INSERT INTO outbound_jobs(id,user_id,message_id,status,payload,created_at,updated_at) VALUES('transport-job','owner','message','queued','{}',1,1)",
		);
		const oldDocument = join(state.directory, "old.json");
		await writeBackup(path, oldDocument);
		const before: unknown = await Bun.file(oldDocument).json();
		expect(coveredTables(old)).not.toContain("mailrun_outbound_snapshots");
		restoreBackup(old, before);
		await migrate(path);
		expect(
			snapshotRows.parse(
				old.query("SELECT * FROM mailrun_outbound_snapshots").all(),
			),
		).toEqual([{ job_id: "transport-job", message_id: "message" }]);
		restoreBackup(old, before);
		expect(
			snapshotRows.parse(
				old.query("SELECT * FROM mailrun_outbound_snapshots").all(),
			),
		).toEqual([{ job_id: "transport-job", message_id: "message" }]);
		const current = join(state.directory, "current.json");
		await writeBackup(path, current);
		const native: unknown = await Bun.file(current).json();
		restoreBackup(old, native);
		expect(
			snapshotRows.parse(
				old.query("SELECT * FROM mailrun_outbound_snapshots").all(),
			),
		).toEqual([{ job_id: "transport-job", message_id: "message" }]);
		old.exec("DELETE FROM messages WHERE id='message'");
		expect(old.query("SELECT message_id FROM outbound_jobs").get()).toEqual({
			message_id: null,
		});
		const orphaned = join(state.directory, "orphaned.json");
		await writeBackup(path, orphaned);
		restoreBackup(state.db, await Bun.file(orphaned).json());
		expect(
			state.db
				.query("SELECT message_id FROM outbound_jobs WHERE id='transport-job'")
				.get(),
		).toEqual({ message_id: null });
		expect(
			snapshotRows.parse(
				state.db.query("SELECT * FROM mailrun_outbound_snapshots").all(),
			),
		).toEqual([{ job_id: "transport-job", message_id: "message" }]);
		expect(
			BACKUP_TABLES.filter((table) => table === "mailrun_outbound_snapshots"),
		).toHaveLength(1);
		expect(
			BACKUP_TABLE_GROUPS.flatMap((group) => group.tables).filter(
				(table) => table === "mailrun_outbound_snapshots",
			),
		).toHaveLength(1);
		expect(INTERNAL_TABLES).not.toContain("mailrun_outbound_snapshots");
		expect(coveredTables(state.db)).toContain("mailrun_outbound_snapshots");
		expect(state.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
	} finally {
		old.close();
		await state.close();
	}
});
test("explicit native snapshot rows override insertion capture and an empty snapshot table remains empty", async () => {
	const state = await fixture();
	try {
		state.db.exec(
			"INSERT INTO outbound_jobs(id,user_id,message_id,status,payload,created_at,updated_at) VALUES('job','owner','message','queued','{}',1,1)",
		);
		const path = join(state.directory, "native.json");
		await writeBackup(state.path, path);
		const document = z
			.object({
				tables: z.record(
					z.string(),
					z.array(
						z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
					),
				),
			})
			.passthrough()
			.parse(await Bun.file(path).json());
		document.tables.mailrun_outbound_snapshots = [
			{ job_id: "job", message_id: "original-transport-id" },
		];
		restoreBackup(state.db, document);
		expect(
			snapshotRows.parse(
				state.db.query("SELECT * FROM mailrun_outbound_snapshots").all(),
			),
		).toEqual([{ job_id: "job", message_id: "original-transport-id" }]);
		document.tables.mailrun_outbound_snapshots = [];
		restoreBackup(state.db, document);
		expect(
			state.db.query("SELECT * FROM mailrun_outbound_snapshots").all(),
		).toEqual([]);
		expect(
			state.db.query("SELECT id FROM outbound_jobs WHERE id='job'").get(),
		).toEqual({ id: "job" });
	} finally {
		await state.close();
	}
});
