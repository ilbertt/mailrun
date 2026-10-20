import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { withDatabase, seconds, id, databasePath } from "../db";
import { writeBackup } from "../../lib/backups/export";
import { LocalStorage } from "../storage";

export async function scheduledBackup() {
	const [settings] = await withDatabase(sql => sql.BackupSettings`SELECT enabled,schedule_type,schedule_value,retention_enabled,retention_days,excluded_table_groups FROM backup_settings WHERE id='default'`);
	if (!settings) return;
	const storage = new LocalStorage();
	if (settings.retention_enabled) {
		const expired = await withDatabase(sql => sql.ExpiredBackups`SELECT id,r2_key FROM backups WHERE status IN ('completed','failed') AND created_at<${seconds() - settings.retention_days * 86400}`);
		for (const backup of expired) {
			if (backup.r2_key) await storage.delete(backup.r2_key);
			await withDatabase(sql => sql.DeleteExpiredBackup`DELETE FROM backups WHERE id=${backup.id}`);
		}
	}
	const now = new Date();
	if (!settings.enabled || (settings.schedule_type === "weekly" && now.getUTCDay() !== settings.schedule_value)
		|| (settings.schedule_type === "monthly" && now.getUTCDate() !== settings.schedule_value)) return;
	const dayStart = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
	const existing = await withDatabase(sql => sql.ExistingDailyBackup`
		SELECT id FROM backups WHERE trigger='scheduled' AND status IN ('queued','running','completed') AND created_at>=${dayStart} LIMIT 1`);
	if (existing.length) return;
	const backupId = id("bak");
	const filename = `mailrun-${now.toISOString().replaceAll(":", "-")}.json`;
	const key = `backups/database/${backupId}/${filename}`;
	const path = storage.path(key);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await withDatabase(sql => sql.StartBackup`
		INSERT INTO backups (id,status,trigger,filename,r2_key,created_at,started_at)
		VALUES (${backupId},'running','scheduled',${filename},${key},${seconds()},${seconds()})`);
	try {
		const excluded = z.array(z.enum(["accounts", "mail", "automation", "assistant", "system"])).parse(JSON.parse(settings.excluded_table_groups));
		await writeBackup(databasePath(), `${path}.tmp`, excluded);
		await rename(`${path}.tmp`, path);
		const size = Bun.file(path).size;
		await withDatabase(sql => sql.CompleteBackup`UPDATE backups SET status='completed',size=${size},completed_at=${seconds()} WHERE id=${backupId}`);
	} catch (error) {
		await withDatabase(sql => sql.FailBackup`UPDATE backups SET status='failed',error=${error instanceof Error ? error.message : "Backup failed"},completed_at=${seconds()} WHERE id=${backupId}`);
		throw error;
	}
}
