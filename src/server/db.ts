import { Database } from "bun:sqlite";
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

export async function migrate(path = databasePath()) {
	const migrations = await Promise.all(
		[...getMigrations()]
			.filter(([name]) => name.endsWith(".sql"))
			.map(async ([name, file]) => ({ name, sql: await file.text() })),
	);
	if (!migrations.length)
		throw new Error("No embedded database migrations found");
	const db = new Database(path, { create: true });
	try {
		db.exec(
			"PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
		);
		db.exec(
			"CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)",
		);
		const applied = new Set(
			db
				.query<{ name: string }, []>("SELECT name FROM d1_migrations")
				.all()
				.map((row) => row.name),
		);
		for (const migration of migrations) {
			if (applied.has(migration.name)) continue;
			db.transaction(() => {
				db.exec(migration.sql);
				db.query("INSERT INTO d1_migrations (name) VALUES (?)").run(
					migration.name,
				);
			})();
		}
	} finally {
		db.close();
	}
	initialized.add(path);
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
	const previous = databaseOperations.get(path) ?? Promise.resolve();
	let release = () => {};
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	databaseOperations.set(path, pending);
	await previous;
	try {
		const sql = withTypes<Queries>(new SQL(`sqlite://${path}`));
		try {
			await sql`PRAGMA foreign_keys=ON`;
			await sql`PRAGMA busy_timeout=5000`;
			return await run(sql);
		} finally {
			await sql.close();
		}
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
