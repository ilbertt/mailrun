import { test, expect, beforeEach, afterEach } from "bun:test";
import { stat, readdir } from "node:fs/promises";
import { fixture, owner, stranger } from "./fixtures";
import {
	backupInventory,
	backupSettingsSchema,
	saveBackupSettings,
	runManualBackup,
	runScheduledBackup,
	removeBackup,
	downloadBackup,
	restoreRecords,
} from "../src/server/backups/service";
import { backupsApi } from "../src/server/api/backups";
import { seconds } from "../src/server/db";
import { LocalStorage } from "../src/server/storage";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
const settings = {
	enabled: true,
	scheduleType: "daily",
	scheduleValue: null,
	retentionEnabled: false,
	retentionDays: 30,
	excludedTableGroups: [],
};

test("backup settings and files require the current primary administrator", async () => {
	for (const task of [
		() => backupInventory(stranger),
		() => saveBackupSettings(stranger, settings),
		() => runManualBackup(stranger),
		() => removeBackup(stranger, "missing"),
		() => downloadBackup(stranger, "missing"),
		() => restoreRecords(stranger, {}),
	]) {
		await expect(task()).rejects.toMatchObject({ status: 403 });
	}
	await saveBackupSettings(owner, {
		...settings,
		scheduleType: "weekly",
		scheduleValue: 3,
		excludedTableGroups: ["assistant", "assistant"],
	});
	expect((await backupInventory(owner)).settings).toMatchObject({
		enabled: true,
		scheduleType: "weekly",
		scheduleValue: 3,
		excludedTableGroups: ["assistant"],
	});
	state.db.exec("UPDATE users SET is_primary_admin=0 WHERE id='owner'");
	await expect(backupInventory(owner)).rejects.toMatchObject({ status: 403 });
});
test("backup settings reject an empty selection and invalid schedule/retention values", () => {
	for (const value of [
		{
			...settings,
			excludedTableGroups: [
				"accounts",
				"mail",
				"automation",
				"assistant",
				"system",
			],
		},
		{ ...settings, scheduleType: "weekly", scheduleValue: 7 },
		{ ...settings, scheduleType: "monthly", scheduleValue: 29 },
		{ ...settings, retentionDays: 0 },
		{ ...settings, excludedTableGroups: ["unknown"] },
	])
		expect(backupSettingsSchema.safeParse(value).success).toBe(false);
	expect(
		backupSettingsSchema.parse({ ...settings, scheduleValue: 99 })
			.scheduleValue,
	).toBeNull();
});
test("manual backups publish complete owner-only local files and stream downloads/HEAD", async () => {
	const backupId = await runManualBackup(owner),
		inventory = await backupInventory(owner);
	expect(inventory.configuration).toEqual({ configured: true, missing: [] });
	expect(inventory.backups[0]).toMatchObject({
		id: backupId,
		status: "completed",
		trigger: "manual",
		createdByUserId: "owner",
		r2Key: expect.stringContaining("backups/database/"),
		error: null,
	});
	expect(inventory.backups[0]?.filename).toStartWith("mailflare-");
	expect(inventory.backups[0]?.size).toBeGreaterThan(0);
	const response = await downloadBackup(owner, backupId),
		document = await response.json();
	expect(document).toMatchObject({
		format: "mailflare-database-backup",
		version: 1,
	});
	expect(document.tables.users).toHaveLength(2);
	expect(document.tables.messages).toHaveLength(1);
	expect(document.tables.mailrun_job_leases).toBeUndefined();
	expect(response.headers.get("content-disposition")).toContain(
		inventory.backups[0]!.filename!,
	);
	expect(response.headers.get("cache-control")).toBe("no-store");
	const head = await downloadBackup(owner, backupId, true);
	expect(await head.text()).toBe("");
	expect(head.headers.get("content-length")).toBe(
		response.headers.get("content-length"),
	);
	const row = state.db
		.query<{ r2_key: string }, [string]>(
			"SELECT r2_key FROM backups WHERE id=?",
		)
		.get(backupId)!;
	const file = new LocalStorage().file(row.r2_key);
	expect((await stat(file.name!)).mode & 0o777).toBe(0o600);
	await removeBackup(owner, backupId);
	expect(await file.exists()).toBe(false);
	expect((await backupInventory(owner)).backups).toEqual([]);
});
test("group exclusions export partial documents that cannot replace a full database", async () => {
	await saveBackupSettings(owner, {
		...settings,
		excludedTableGroups: ["assistant", "automation"],
	});
	const id = await runManualBackup(owner),
		document: unknown = await (await downloadBackup(owner, id)).json();
	expect(JSON.stringify(document)).toContain('"users":[');
	expect(JSON.stringify(document)).not.toContain('"webhooks":');
	await expect(restoreRecords(owner, document)).rejects.toThrow(
		"Restore requires a full backup",
	);
	expect(state.db.query("SELECT id FROM messages").all()).toHaveLength(1);
});
test("restore replaces records atomically, rebuilds search and preserves file objects", async () => {
	const storage = new LocalStorage();
	await storage.put("messages/original.eml", "MIME remains local");
	state.db.exec("UPDATE messages SET raw_r2_key='messages/original.eml'");
	const id = await runManualBackup(owner),
		document = await (await downloadBackup(owner, id)).json();
	state.db.exec(
		"UPDATE messages SET subject='Changed'; UPDATE users SET name='Changed' WHERE id='owner'",
	);
	await restoreRecords(owner, document);
	expect(state.db.query("SELECT subject FROM messages").all()).toEqual([
		{ subject: "A searchable subject" },
	]);
	expect(
		state.db.query("SELECT name FROM users WHERE id='owner'").get(),
	).toEqual({ name: "Owner" });
	expect(
		state.db
			.query(
				"SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'searchable'",
			)
			.all(),
	).toHaveLength(1);
	expect(await storage.file("messages/original.eml").text()).toBe(
		"MIME remains local",
	);
	expect(state.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
	expect(state.db.query("SELECT * FROM mailrun_job_leases").all()).toEqual([]);
	document.tables.messages[0].mailbox_id = "missing-mailbox";
	await expect(restoreRecords(owner, document)).rejects.toThrow();
	expect(state.db.query("SELECT subject FROM messages").all()).toEqual([
		{ subject: "A searchable subject" },
	]);
});
test("live operations exclude manual, restore, delete and cron across the persisted lease", async () => {
	state.db
		.query(
			"INSERT INTO mailrun_job_leases VALUES ('backup-operation','another-process',?)",
		)
		.run(seconds() + 60);
	for (const task of [
		() => runManualBackup(owner),
		() => restoreRecords(owner, {}),
		() => removeBackup(owner, "missing"),
	])
		await expect(task()).rejects.toMatchObject({ status: 409 });
	await saveBackupSettings(owner, settings);
	await runScheduledBackup();
	expect(state.db.query("SELECT id FROM backups").all()).toEqual([]);
	state.db.exec(
		"UPDATE mailrun_job_leases SET expires_at=0; INSERT INTO backups(id,status,trigger,created_at) VALUES ('interrupted','running','manual',1)",
	);
	await runManualBackup(owner);
	expect(
		state.db
			.query("SELECT status,error FROM backups WHERE id='interrupted'")
			.get(),
	).toEqual({
		status: "failed",
		error: "Backup interrupted before completion",
	});
	expect(state.db.query("SELECT * FROM mailrun_job_leases").all()).toEqual([]);
});
test("scheduling uses UTC and retention still runs when scheduled backups are disabled", async () => {
	const now = new Date();
	await saveBackupSettings(owner, {
		...settings,
		scheduleType: "weekly",
		scheduleValue: (now.getUTCDay() + 1) % 7,
	});
	await runScheduledBackup(now);
	expect((await backupInventory(owner)).backups).toEqual([]);
	await saveBackupSettings(owner, {
		...settings,
		scheduleType: "weekly",
		scheduleValue: now.getUTCDay(),
	});
	await runScheduledBackup(now);
	await runScheduledBackup(now);
	expect((await backupInventory(owner)).backups).toHaveLength(1);
	const storage = new LocalStorage();
	await storage.put("backups/old.json", "old");
	await storage.put("backups/shared.json", "referenced twice");
	state.db
		.query(
			"INSERT INTO backups(id,status,trigger,r2_key,created_at) VALUES ('old','completed','manual','backups/old.json',1),('shared','completed','manual','backups/shared.json',1),('new','completed','manual','backups/shared.json',?)",
		)
		.run(seconds());
	await saveBackupSettings(owner, {
		...settings,
		enabled: false,
		retentionEnabled: true,
		retentionDays: 1,
	});
	await runScheduledBackup(now);
	expect(await storage.file("backups/old.json").exists()).toBe(false);
	expect(await storage.file("backups/shared.json").exists()).toBe(true);
	expect(
		state.db.query("SELECT id FROM backups WHERE id IN('old','shared')").all(),
	).toEqual([]);
});
test("failed exports retain a failure record and remove staged files", async () => {
	state.db.exec("CREATE TABLE unexpected_persisted_table(id TEXT)");
	await expect(runManualBackup(owner)).rejects.toThrow("Backup does not cover");
	const inventory = await backupInventory(owner);
	expect(inventory.backups[0]?.status).toBe("failed");
	expect(inventory.backups[0]?.error).toContain("unexpected_persisted_table");
	expect(
		await readdir(
			`${state.directory}/blobs/backups/database/${inventory.backups[0]!.id}`,
		),
	).toEqual([]);
	expect(state.db.query("SELECT * FROM mailrun_job_leases").all()).toEqual([]);
	await expect(
		downloadBackup(owner, inventory.backups[0]!.id),
	).rejects.toMatchObject({ status: 404 });
});
test("restore HTTP contract rejects missing, malformed and incomplete documents", async () => {
	for (const value of [undefined, "not JSON", '{"tables":{}}']) {
		const form = new FormData();
		if (value !== undefined)
			form.set(
				"backup",
				new File([value], "backup.json", { type: "application/json" }),
			);
		await expect(
			backupsApi(
				new Request("http://localhost/api/backups/restore", {
					method: "POST",
					body: form,
				}),
				owner,
			),
		).rejects.toMatchObject({ status: 400 });
	}
	expect(state.db.query("SELECT id FROM messages").all()).toHaveLength(1);
});
