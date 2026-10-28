import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { z } from "zod";
import { SQL } from "bun";
import { withTypes, type TypedSQL } from "@ilbertt/bun-sqlgen";
import { join } from "node:path";
import { dataDirectory } from "./config";
import { getMigrations } from "./assets";
import type { Queries } from "../queries.gen";

export type AppSQL = TypedSQL<Queries>;
// The compiled Bun entrypoint and Start's bundle must serialize the same SQLite
// callbacks; separate locks can block the event loop while another bundle awaits.
declare global {
	var __mailrunDatabaseState:
		| {
				initialized: Set<string>;
				initializing: Map<string, Promise<void>>;
				operations: Map<string, Promise<void>>;
		  }
		| undefined;
}
const state = (globalThis.__mailrunDatabaseState ??= {
	initialized: new Set(),
	initializing: new Map(),
	operations: new Map(),
});
const { initialized, initializing } = state;

export function databasePath() {
	return join(dataDirectory(), "mailflare.sqlite");
}

export type MigrationStatus = {
	ready: boolean;
	pending: string[];
	unknown: string[];
};
const migrationNames = z.array(z.object({ name: z.string() }));
async function bundledMigrations() {
	const migrations = await Promise.all(
		[...getMigrations()]
			.filter(([name]) => name.endsWith(".sql"))
			.map(async ([name, file]) => ({ name, sql: await file.text() })),
	);
	if (!migrations.length)
		throw new Error("No embedded database migrations found");
	return migrations;
}
// Bookkeeping/schema SQL shares the migration executor's validated metadata
// path. It must work before any application table or SQLgen registry exists.
function appliedMigrationNames(db: Database) {
	const exists = z
		.object({ name: z.string() })
		.nullable()
		.parse(
			db
				.query(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations'",
				)
				.get(),
		);
	return exists
		? migrationNames
				.parse(db.query("SELECT name FROM d1_migrations").all())
				.map((row) => row.name)
		: [];
}
function migrationStatus(
	names: string[],
	migrations: { name: string }[],
): MigrationStatus {
	const applied = new Set(names),
		known = new Set(migrations.map((m) => m.name)),
		pending = migrations.filter((m) => !applied.has(m.name)).map((m) => m.name),
		unknown = [...applied].filter((name) => !known.has(name)).sort();
	return { ready: !pending.length && !unknown.length, pending, unknown };
}
export async function getMigrationStatus(
	path = databasePath(),
): Promise<MigrationStatus> {
	const migrations = await bundledMigrations();
	if (!existsSync(path)) return migrationStatus([], migrations);
	const db = new Database(path, { readonly: true });
	try {
		return migrationStatus(appliedMigrationNames(db), migrations);
	} finally {
		db.close();
	}
}
async function runMigrations(path: string, rejectUnknown: boolean) {
	const migrations = await bundledMigrations();
	return databaseOperation(async () => {
		const db = new Database(path, { create: true }),
			applied: string[] = [];
		try {
			db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
			// Switching an existing rollback journal to WAL can fail immediately
			// while another process holds a schema read lock, despite busy_timeout.
			const deadline = Date.now() + 5000;
			for (;;) {
				try {
					db.exec("PRAGMA journal_mode=WAL");
					break;
				} catch (error) {
					if (
						!(error instanceof Error) ||
						!("code" in error) ||
						error.code !== "SQLITE_BUSY" ||
						Date.now() >= deadline
					)
						throw error;
					await Bun.sleep(20);
				}
			}
			const initial = migrationStatus(appliedMigrationNames(db), migrations);
			if (rejectUnknown && initial.unknown.length)
				throw new Error(
					"The database contains migrations that are not part of this Mailflare release.",
				);
			db.exec(
				"CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)",
			);
			for (const migration of migrations) {
				if (!initial.pending.includes(migration.name)) continue;
				const changed = db
					.transaction(() => {
						const names = appliedMigrationNames(db);
						if (
							rejectUnknown &&
							migrationStatus(names, migrations).unknown.length
						)
							throw new Error(
								"The database contains migrations that are not part of this Mailflare release.",
							);
						if (names.includes(migration.name)) return false;
						db.exec(migration.sql);
						db.query("INSERT INTO d1_migrations (name) VALUES (?)").run(
							migration.name,
						);
						return true;
					})
					.immediate();
				if (changed) applied.push(migration.name);
			}
			initialized.add(path);
			return {
				...migrationStatus(appliedMigrationNames(db), migrations),
				applied,
			};
		} finally {
			db.close();
		}
	}, path);
}
export async function migrate(path = databasePath()) {
	await runMigrations(path, false);
}
export async function applyPendingMigrations(path = databasePath()) {
	return runMigrations(path, true);
}

// Bun's SQLite queries can wait synchronously on a write lock. Serializing the
// short database callbacks prevents another request from blocking this process
// while an async transaction is waiting to resume. Network and file work stays
// outside these callbacks. Separate cron processes use SQLite's busy timeout.
const databaseOperations = state.operations;
export async function withDatabase<T>(
	run: (sql: AppSQL) => Promise<T>,
	path = databasePath(),
): Promise<T> {
	if (!initialized.has(path)) {
		let pending = initializing.get(path);
		if (!pending) {
			pending = migrate(path).finally(() => initializing.delete(path));
			initializing.set(path, pending);
		}
		await pending;
	}
	return databaseOperation(async () => {
		const sql = withTypes<Queries>(new SQL(`sqlite://${path}`));
		try {
			await sql`PRAGMA foreign_keys=ON`;
			await sql`PRAGMA busy_timeout=5000`;
			return await run(sql);
		} finally {
			await sql.close();
		}
	}, path);
}
async function databaseOperation<T>(
	run: () => Promise<T>,
	path: string,
): Promise<T> {
	const previous = databaseOperations.get(path) ?? Promise.resolve();
	let release = () => {};
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	databaseOperations.set(path, pending);
	await previous;
	try {
		return await run();
	} finally {
		release();
		if (databaseOperations.get(path) === pending)
			databaseOperations.delete(path);
	}
}

export function seconds() {
	return Math.floor(Date.now() / 1000);
}
export function id(prefix = "id") {
	return `${prefix}_${crypto.randomUUID()}`;
}

/** A WAL read snapshot can stream exports without holding the request write queue. */
export async function withReadSnapshot<T>(run: (sql: AppSQL) => Promise<T>) {
	const path = databasePath();
	await withDatabase(async () => {}, path);
	const sql = withTypes<Queries>(
		new SQL({ adapter: "sqlite", filename: path, readonly: true }),
	);
	try {
		await sql`PRAGMA busy_timeout=5000`;
		return await sql.begin(run);
	} finally {
		await sql.close();
	}
}
