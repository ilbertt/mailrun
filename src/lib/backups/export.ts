import { Database } from "bun:sqlite";
import { open, type FileHandle } from "node:fs/promises";
import { z } from "zod";
import { BACKUP_TABLE_GROUPS } from "./table-groups";
import type { DatabaseBackupTable } from "./types";

// Parent-first order, also checked against SQLite's foreign-key catalog.
export const BACKUP_TABLES: DatabaseBackupTable[] = [
	"users",
	"domains",
	"mailboxes",
	"mailbox_access",
	"contacts",
	"mailrun_contact_avatar_jobs",
	"folders",
	"api_keys",
	"messages",
	"message_attachments",
	"shared_attachment_links",
	"outbound_jobs",
	"routing_rules",
	"webhooks",
	"webhook_deliveries",
	"sessions",
	"push_subscriptions",
	"audit_logs",
	"backup_settings",
	"backups",
	"app_settings",
	"license_settings",
	"email_templates",
	"calendar_events",
	"booking_events",
	"auto_reply_deliveries",
	"spam_token_stats",
	"spam_reputation",
	"spam_feedback",
	"mailbox_aliases",
	"password_reset_tokens",
	"mfa_recovery_codes",
	"login_challenges",
	"mailbox_agent_settings",
	"agent_conversations",
	"agent_chat_messages",
	"agent_jobs",
	"agent_draft_metadata",
	"agent_send_approvals",
	"mcp_key_mailboxes",
	"ai_usage",
	"drive_items",
	"drive_shares",
	"drive_upload_parts",
	"mailrun_installation",
	"mailrun_jmap_uploads",
	"mailrun_ses_receipts", // Acknowledge retries after their temporary S3 objects were consumed.
];
export const INTERNAL_TABLES = [
	"d1_migrations",
	"jmap_mailbox_revisions", // Rebuilt by message triggers.
	"mailrun_job_leases", // Process leases expire; restoring them would block work.
	"mailrun_contact_avatar_revisions", // Derived live-refresh ticks; mailbox deletion/restore resets them.
];
const REQUIRED_BACKUP_TABLES: DatabaseBackupTable[] = [
	"users",
	"domains",
	"mailboxes",
	"mailbox_access",
	"contacts",
	"folders",
	"api_keys",
	"messages",
	"message_attachments",
	"outbound_jobs",
	"routing_rules",
	"webhooks",
	"webhook_deliveries",
	"sessions",
	"audit_logs",
	"backup_settings",
	"backups",
	"app_settings",
	"license_settings",
];
const recordSchema = z.record(
	z.string(),
	z.union([z.string(), z.number(), z.null()]),
);
const documentSchema = z.object({
	format: z.literal("mailflare-database-backup"),
	version: z.literal(1),
	createdAt: z.string(),
	includedTables: z.array(z.string()).optional(),
	tables: z.record(z.string(), z.array(recordSchema)),
});
const nameRows = z.array(z.object({ name: z.string() }));
function identifier(name: string) {
	return `"${name.replaceAll('"', '""')}"`;
}

export function coveredTables(db: Database): DatabaseBackupTable[] {
	const names = nameRows
		.parse(db.query("SELECT name FROM sqlite_master WHERE type='table'").all())
		.map((row) => row.name);
	const known = new Set<string>(BACKUP_TABLES);
	const unknown = names.filter(
		(name) =>
			!known.has(name) &&
			!INTERNAL_TABLES.includes(name) &&
			!name.startsWith("sqlite_") &&
			!name.startsWith("_cf") &&
			!name.startsWith("messages_fts"),
	);
	if (unknown.length)
		throw new Error(`Backup does not cover: ${unknown.join(", ")}`);
	const assigned = BACKUP_TABLE_GROUPS.flatMap((group) => group.tables);
	for (const table of BACKUP_TABLES) {
		if (assigned.filter((name) => name === table).length !== 1)
			throw new Error(`Backup group mismatch: ${table}`);
	}
	const tables = BACKUP_TABLES.filter((table) => names.includes(table));
	for (const [index, table] of tables.entries()) {
		const parents = z
			.array(z.object({ table: z.string() }))
			.parse(db.query(`PRAGMA foreign_key_list(${identifier(table)})`).all());
		for (const parent of parents) {
			if (
				parent.table !== table &&
				tables.findIndex((name) => name === parent.table) > index
			)
				throw new Error(`Backup order: ${parent.table} must precede ${table}`);
		}
	}
	return tables;
}

// Schema-driven backup SQL is deliberately dynamic. Identifiers come only from
// the migration catalog/allowlist; imported values always use bound parameters.
export async function writeBackup(
	databasePath: string,
	destination: string,
	excludedGroups: string[] = [],
) {
	const db = new Database(databasePath);
	let target: FileHandle | undefined;
	try {
		target = await open(destination, "w", 0o600);
		await target.chmod(0o600);
	} catch (error) {
		db.close();
		if (target) await target.close();
		throw error;
	}
	const writer = Bun.file(target.fd).writer({ highWaterMark: 1024 * 1024 });
	let ended = false;
	try {
		db.exec("BEGIN");
		const allowed = new Set(
			BACKUP_TABLE_GROUPS.filter(
				(group) => !excludedGroups.includes(group.id),
			).flatMap((group) => group.tables),
		);
		const tables = coveredTables(db).filter((table) => allowed.has(table));
		if (!tables.length)
			throw new Error("At least one backup group must be included");
		writer.write(
			`{"format":"mailflare-database-backup","version":1,"createdAt":${JSON.stringify(new Date().toISOString())},${excludedGroups.length ? `"includedTables":${JSON.stringify(tables)},` : ""}"tables":{`,
		);
		for (const [index, table] of tables.entries()) {
			writer.write(`${index ? "," : ""}${JSON.stringify(table)}:[`);
			let first = true,
				buffered = 0;
			for (const raw of db
				.query(`SELECT * FROM ${identifier(table)}`)
				.iterate()) {
				const row = recordSchema.parse(raw);
				const written = writer.write(
					`${first ? "" : ","}${JSON.stringify(row)}`,
				);
				buffered += typeof written === "number" ? written : await written;
				first = false;
				if (buffered >= 1024 * 1024) {
					await writer.flush();
					buffered = 0;
				}
			}
			writer.write("]");
			await writer.flush();
		}
		writer.write("}}");
		await writer.end();
		ended = true;
		await target.sync();
		db.exec("COMMIT");
	} finally {
		if (!ended) {
			try {
				await writer.end();
			} catch {}
		}
		db.close();
		await target.close();
	}
}

export function restoreBackup(db: Database, input: unknown) {
	const document = documentSchema.parse(input);
	for (const table of Object.keys(document.tables)) {
		if (
			table !== "message_bodies" &&
			!BACKUP_TABLES.some((known) => known === table)
		)
			throw new Error(`Unknown backup table: ${table}`);
	}
	const tables = coveredTables(db);
	if (
		document.includedTables &&
		!BACKUP_TABLE_GROUPS.every((group) =>
			group.tables.some((table) => document.includedTables?.includes(table)),
		)
	) {
		throw new Error("Restore requires a full backup");
	}
	for (const required of REQUIRED_BACKUP_TABLES) {
		if (!document.tables[required])
			throw new Error(`Backup is missing ${required}`);
	}
	for (const table of BACKUP_TABLES) {
		if (!tables.includes(table) && document.tables[table]?.length)
			throw new Error(`Apply migrations before restoring ${table}`);
	}
	// Older databases can ignore newly nullable token fields, but must not drop
	// the only usable credential from a Global API Key installation backup.
	if (
		document.tables.mailrun_installation?.some(
			(row) => row.api_key || row.api_email,
		)
	) {
		const columns = nameRows.parse(
			db.query('PRAGMA table_info("mailrun_installation")').all(),
		);
		if (
			!["api_key", "api_email"].every((name) =>
				columns.some((column) => column.name === name),
			)
		)
			throw new Error(
				"Apply migrations before restoring Cloudflare Global API Key credentials",
			);
	}
	const legacy = new Map(
		(document.tables.message_bodies ?? []).map((row) => [row.message_id, row]),
	);
	for (const message of document.tables.messages ?? []) {
		const body = legacy.get(message.id);
		if (body)
			for (const column of ["text_body", "html_body", "raw_r2_key"]) {
				if (!(column in message) && column in body)
					message[column] = body[column] ?? null;
			}
	}
	db.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
	db.transaction(() => {
		db.exec("PRAGMA defer_foreign_keys=ON");
		for (const table of [...tables].reverse())
			db.exec(`DELETE FROM ${identifier(table)}`);
		for (const table of tables) {
			const columns = new Set(
				nameRows
					.parse(db.query(`PRAGMA table_info(${identifier(table)})`).all())
					.map((row) => row.name),
			);
			for (const row of document.tables[table] ?? []) {
				if (
					table === "booking_events" &&
					row.slug === undefined &&
					typeof row.id === "string"
				)
					row.slug = Buffer.from(row.id).toString("hex");
				const keys = Object.keys(row).filter((key) => columns.has(key));
				if (!keys.length) throw new Error(`Empty ${table} record`);
				db.query(
					`INSERT INTO ${identifier(table)} (${keys.map(identifier).join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
				).run(...keys.map((key) => row[key] ?? null));
			}
		}
		if (db.query("PRAGMA foreign_key_check").all().length)
			throw new Error("Backup has invalid foreign keys");
	})();
}
