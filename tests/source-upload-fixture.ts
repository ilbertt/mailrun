import { join } from "node:path";
import capture from "./source-uploads-capture.json";
import { LocalStorage } from "../src/server/storage";
import type { Database } from "bun:sqlite";
import { deepStrictEqual, equal, ok } from "node:assert/strict";

export const sourceUploadsCapture = capture;
export function verifyOriginalRecordFields(
	db: Database,
	tables: Record<string, Record<string, unknown>[]> = capture.backup.tables,
) {
	let records = 0,
		columns = 0;
	for (const [table, sourceRows] of Object.entries(tables)) {
		const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
		const rows = db.query(`SELECT * FROM ${quote(table)}`).all() as Record<
			string,
			unknown
		>[];
		equal(
			rows.length,
			sourceRows.length,
			`Original record count differs: ${table}`,
		);
		if (!sourceRows.length) continue;
		// These provider identifiers are deliberately translated; completion and
		// byte checks independently verify the resulting native upload state.
		const ignored =
			table === "drive_items"
				? ["upload_id"]
				: table === "drive_upload_parts"
					? ["etag"]
					: [];
		const keys = Object.keys(sourceRows[0]!).filter(
			(key) => !ignored.includes(key),
		);
		for (const row of rows)
			for (const key of keys)
				ok(Object.hasOwn(row, key), `Missing original field ${table}.${key}`);
		const project = (values: object[]) =>
			values
				.map((value) =>
					keys.map((key) => (value as Record<string, unknown>)[key]),
				)
				.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
		deepStrictEqual(
			project(rows),
			project(sourceRows),
			`Original fields differ: ${table}`,
		);
		records += rows.length;
		columns += rows.length * keys.length;
	}
	return {
		tables: Object.keys(tables).length,
		records,
		fields: columns,
	};
}
export async function prepareSourceUploads(
	directory: string,
	source: {
		backup: unknown;
		files: { key: string; base64: string; sha256: string }[];
	} = capture,
) {
	const bucket = join(directory, "original-bucket"),
		store = new LocalStorage(bucket);
	for (const file of source.files) {
		const bytes = Buffer.from(file.base64, "base64");
		if (
			new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== file.sha256
		)
			throw new Error("Original upload fixture hash mismatch");
		await store.put(file.key, bytes);
	}
	const backup = join(directory, "original-records.json");
	await new LocalStorage(directory).put(
		"original-records.json",
		JSON.stringify(source.backup),
	);
	return { bucket, backup };
}
