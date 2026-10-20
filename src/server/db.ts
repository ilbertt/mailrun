import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { withTypes, type TypedSQL } from "@ilbertt/bun-sqlgen";
import { join } from "node:path";
import { dataDirectory } from "./config";
import { getMigrations } from "./assets";
import type { Queries } from "../queries.gen";

export type AppSQL = TypedSQL<Queries>;
const initialized = new Set<string>();
const initializing = new Map<string, Promise<void>>();

export function databasePath() { return join(dataDirectory(), "mailflare.sqlite"); }

export async function migrate(path = databasePath()) {
	const migrations = await Promise.all([...getMigrations()].filter(([name]) => name.endsWith(".sql")).map(async ([name, file]) => ({ name, sql: await file.text() })));
	if (!migrations.length) throw new Error("No embedded database migrations found");
	const db = new Database(path, { create: true });
	try {
		db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
		db.exec("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)");
		const applied = new Set(db.query<{ name: string }, []>("SELECT name FROM d1_migrations").all().map(row => row.name));
		for (const migration of migrations) {
			if (applied.has(migration.name)) continue;
			db.transaction(() => {
				db.exec(migration.sql);
				db.query("INSERT INTO d1_migrations (name) VALUES (?)").run(migration.name);
			})();
		}
	} finally { db.close(); }
	initialized.add(path);
}

// Each operation gets its own connection: SQLite transactions must not capture
// unrelated requests while an async transaction callback is awaiting a query.
export async function withDatabase<T>(run: (sql: AppSQL) => Promise<T>, path = databasePath()): Promise<T> {
	if (!initialized.has(path)) {
		let pending = initializing.get(path);
		if (!pending) {
			pending = migrate(path).finally(() => initializing.delete(path));
			initializing.set(path, pending);
		}
		await pending;
	}
	const sql = withTypes<Queries>(new SQL(`sqlite://${path}`));
	try {
		await sql`PRAGMA foreign_keys=ON`;
		await sql`PRAGMA busy_timeout=5000`;
		return await run(sql);
	} finally { await sql.close(); }
}

export function seconds() { return Math.floor(Date.now() / 1000); }
export function id(prefix = "id") { return `${prefix}_${crypto.randomUUID()}`; }
