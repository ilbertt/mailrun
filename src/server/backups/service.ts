import { Database } from "bun:sqlite";
import { mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { User } from "../../shared/contracts";
import { writeBackup, restoreBackup } from "../../lib/backups/export";
import { parseExcludedBackupTableGroups } from "../../lib/backups/table-groups";
import { withDatabase, databasePath, id, seconds, type AppSQL } from "../db";
import { keyActor } from "../auth/key-management";
import { LocalStorage, deleteUnreferencedObjects } from "../storage";
import { adminWrite } from "../admin/accounts";
import { prepareObjectRestore } from "../migration/restore-objects";

const group = z.enum(["accounts", "mail", "automation", "assistant", "system"]);
export const backupSettingsSchema = z
	.object({
		enabled: z.boolean(),
		scheduleType: z.enum(["daily", "weekly", "monthly"]),
		scheduleValue: z.coerce.number().int().nullable().optional(),
		retentionEnabled: z.boolean(),
		retentionDays: z.coerce.number().int().min(1).max(3650),
		excludedTableGroups: z
			.array(group)
			.transform((values) => [...new Set(values)])
			.refine((values) => values.length < 5),
	})
	.superRefine((value, ctx) => {
		if (
			(value.scheduleType === "weekly" &&
				(value.scheduleValue == null ||
					value.scheduleValue < 0 ||
					value.scheduleValue > 6)) ||
			(value.scheduleType === "monthly" &&
				(value.scheduleValue == null ||
					value.scheduleValue < 1 ||
					value.scheduleValue > 28))
		) {
			ctx.addIssue({
				code: "custom",
				path: ["scheduleValue"],
				message: "Invalid schedule day",
			});
		}
	})
	.transform((value) => ({
		...value,
		scheduleValue:
			value.scheduleType === "daily" ? null : (value.scheduleValue ?? null),
	}));

async function settingsRow(sql: AppSQL) {
	const [row] =
		await sql.NativeBackupSettings`SELECT * FROM backup_settings WHERE id='default'`;
	if (!row) throw new Error("Backup settings are missing");
	return row;
}
function iso(value: number | null) {
	return value == null ? null : new Date(value * 1000).toISOString();
}
export async function backupInventory(user: User) {
	return withDatabase(async (sql) => {
		await keyActor(sql, user, true);
		const row = await settingsRow(sql);
		const backups =
			await sql.NativeBackupInventory`SELECT id,status,trigger,filename,r2_key,created_by_user_id,size,error,created_at,started_at,completed_at FROM backups ORDER BY created_at DESC,rowid DESC LIMIT 100`;
		return {
			settings: {
				id: row.id,
				enabled: !!row.enabled,
				scheduleType: row.schedule_type,
				scheduleValue: row.schedule_value,
				retentionEnabled: !!row.retention_enabled,
				retentionDays: row.retention_days,
				excludedTableGroups: parseExcludedBackupTableGroups(
					row.excluded_table_groups,
				),
				updatedAt: iso(row.updated_at),
			},
			backups: backups.map((row) => ({
				id: row.id,
				status: row.status,
				trigger: row.trigger,
				filename: row.filename,
				r2Key: row.r2_key,
				createdByUserId: row.created_by_user_id,
				size: row.size,
				error: row.error,
				createdAt: iso(row.created_at),
				startedAt: iso(row.started_at),
				completedAt: iso(row.completed_at),
			})),
			configuration: { configured: true, missing: [] as string[] },
		};
	});
}
export async function saveBackupSettings(user: User, value: unknown) {
	const input = backupSettingsSchema.parse(value);
	await adminWrite(async (sql) => {
		await keyActor(sql, user, true);
		await sql.NativeUpdateBackupSettings`UPDATE backup_settings SET enabled=${input.enabled ? 1 : 0},schedule_type=${input.scheduleType},schedule_value=${input.scheduleValue},retention_enabled=${input.retentionEnabled ? 1 : 0},retention_days=${input.retentionDays},excluded_table_groups=${JSON.stringify(input.excludedTableGroups)},updated_at=${seconds()} WHERE id='default'`;
	});
}

// Manual requests, cron and restore share one persisted lease across processes.
// A heartbeat keeps long exports protected while their read snapshot is open.
async function withBackupOperation<T>(
	run: () => Promise<T>,
	user?: User,
): Promise<T> {
	const owner = id("backup-lease");
	await adminWrite(async (sql) => {
		if (user) await keyActor(sql, user, true);
		const [lease] =
			await sql.NativeClaimBackupOperation`INSERT INTO mailrun_job_leases(name,owner,expires_at) VALUES('backup-operation',${owner},${seconds() + 600}) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE mailrun_job_leases.expires_at<${seconds()} RETURNING owner`;
		if (!lease)
			throw new Response("A backup or restore is already in progress", {
				status: 409,
			});
		await sql.NativeInterruptOldBackups`UPDATE backups SET status='failed',error='Backup interrupted before completion',completed_at=${seconds()} WHERE status IN('queued','running')`;
	});
	let heartbeat = Promise.resolve();
	const timer = setInterval(() => {
		heartbeat = heartbeat
			.then(() =>
				withDatabase(async (sql) => {
					await sql.NativeRenewBackupOperation`UPDATE mailrun_job_leases SET expires_at=${seconds() + 600} WHERE name='backup-operation' AND owner=${owner}`;
				}),
			)
			.catch((error) => {
				console.error("Backup lease renewal failed", error);
			});
	}, 30_000);
	try {
		return await run();
	} finally {
		clearInterval(timer);
		await heartbeat;
		await withDatabase(
			(sql) =>
				sql.NativeReleaseBackupOperation`DELETE FROM mailrun_job_leases WHERE name='backup-operation' AND owner=${owner}`,
		);
	}
}
async function removeExpired() {
	const [settings] = await withDatabase(
		(sql) =>
			sql.NativeBackupRetentionSettings`SELECT retention_enabled,retention_days FROM backup_settings WHERE id='default'`,
	);
	if (!settings?.retention_enabled) return;
	const removed = await withDatabase(
		(sql) =>
			sql.NativePurgeBackups`DELETE FROM backups WHERE status IN('completed','failed') AND created_at<${seconds() - settings.retention_days * 86400} RETURNING r2_key`,
	);
	await deleteUnreferencedObjects(
		removed.flatMap((row) => (row.r2_key ? [row.r2_key] : [])),
	);
}
async function createAndRun(
	trigger: "manual" | "scheduled",
	createdBy?: string,
) {
	const backupId = id("bak"),
		storage = new LocalStorage();
	const filename = `mailflare-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
	const key = `backups/database/${backupId}/${filename}`,
		path = storage.path(key),
		temporary = `${path}.tmp`;
	await withDatabase(
		(sql) =>
			sql.NativeCreateBackup`INSERT INTO backups(id,status,trigger,filename,r2_key,created_by_user_id,created_at,started_at) VALUES(${backupId},'running',${trigger},${filename},${key},${createdBy ?? null},${seconds()},${seconds()})`,
	);
	try {
		const settings = await withDatabase(settingsRow);
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await writeBackup(
			databasePath(),
			temporary,
			parseExcludedBackupTableGroups(settings.excluded_table_groups),
		);
		await storage.publish(key + ".tmp", key);
		await withDatabase(
			(sql) =>
				sql.NativeFinishBackup`UPDATE backups SET status='completed',size=${Bun.file(path).size},completed_at=${seconds()},error=NULL WHERE id=${backupId}`,
		);
		await removeExpired();
		return backupId;
	} catch (error) {
		await withDatabase(
			(sql) =>
				sql.NativeFailBackup`UPDATE backups SET status='failed',error=${error instanceof Error ? error.message : "Backup failed"},completed_at=${seconds()} WHERE id=${backupId}`,
		);
		throw error;
	} finally {
		await unlink(temporary).catch(() => {});
	}
}
export async function runManualBackup(user: User) {
	return withBackupOperation(() => createAndRun("manual", user.id), user);
}
export async function runScheduledBackup(now = new Date()) {
	try {
		await withBackupOperation(async () => {
			const settings = await withDatabase(settingsRow);
			if (
				settings.enabled &&
				(settings.schedule_type !== "weekly" ||
					now.getUTCDay() === settings.schedule_value) &&
				(settings.schedule_type !== "monthly" ||
					now.getUTCDate() === settings.schedule_value)
			) {
				const start = Math.floor(
					Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) /
						1000,
				);
				const existing = await withDatabase(
					(sql) =>
						sql.NativeDailyBackupExists`SELECT id FROM backups WHERE trigger='scheduled' AND status IN('queued','running','completed') AND created_at>=${start} AND created_at<${start + 86400} LIMIT 1`,
				);
				if (!existing.length) {
					await createAndRun("scheduled");
					return;
				}
			}
			await removeExpired();
		});
	} catch (error) {
		if (!(error instanceof Response && error.status === 409)) throw error;
	}
}
export async function removeBackup(user: User, backupId: string) {
	await withBackupOperation(async () => {
		const removed = await adminWrite(async (sql) => {
			await keyActor(sql, user, true);
			const [row] =
				await sql.NativeBackupToDelete`SELECT status FROM backups WHERE id=${backupId}`;
			if (!row) throw new Response("Backup not found", { status: 404 });
			if (row.status === "queued" || row.status === "running")
				throw new Response("A backup in progress cannot be deleted", {
					status: 409,
				});
			return sql.NativeDeleteBackup`DELETE FROM backups WHERE id=${backupId} RETURNING r2_key`;
		});
		await deleteUnreferencedObjects(
			removed.flatMap((row) => (row.r2_key ? [row.r2_key] : [])),
		);
	}, user);
}
export async function downloadBackup(
	user: User,
	backupId: string,
	head = false,
) {
	const row = await withDatabase(async (sql) => {
		await keyActor(sql, user, true);
		const [row] =
			await sql.NativeBackupDownload`SELECT filename,r2_key,status FROM backups WHERE id=${backupId}`;
		if (!row?.r2_key || row.status !== "completed")
			throw new Response("Backup file not found", { status: 404 });
		return row;
	});
	const file = new LocalStorage().file(row.r2_key!);
	if (!(await file.exists()))
		throw new Response("Backup file not found", { status: 404 });
	const filename = (row.filename ?? `${backupId}.sql`).replace(
		/[\r\n"\\]/g,
		"_",
	);
	return new Response(head ? null : file, {
		headers: {
			"Content-Type": "application/sql",
			"Content-Length": String(file.size),
			"Content-Disposition": `attachment; filename="${filename}"`,
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}
export async function restoreRecords(user: User, document: unknown) {
	await withBackupOperation(async () => {
		// Join request serialization before opening the synchronous restore connection.
		// SQLite commits all table replacements and FTS changes atomically.
		await withDatabase(async (sql) => {
			await keyActor(sql, user, true);
			const prepared = await prepareObjectRestore(sql, document);
			const db = new Database(databasePath());
			try {
				db.exec("PRAGMA busy_timeout=5000");
				restoreBackup(db, prepared.document, {
					missingTableRows: prepared.missingTableRows,
				});
			} finally {
				db.close();
			}
		});
	}, user);
}
