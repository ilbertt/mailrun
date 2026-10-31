import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { fixture } from "./fixtures";
import { migrateSourceBucket } from "../src/server/migration/source-bucket";
import {
	prepareSourceUploads,
	verifyOriginalRecordFields,
} from "./source-upload-fixture";
import capture from "./source-features-capture.json";

test("original populated feature records survive source import without field loss", async () => {
	expect(
		new Bun.CryptoHasher("sha256")
			.update(
				await Bun.file(
					new URL("./source-feature-state.sql", import.meta.url),
				).arrayBuffer(),
			)
			.digest("hex"),
	).toBe(capture.provenance.featureSeedSha256);
	const state = await fixture();
	try {
		const source = await prepareSourceUploads(state.directory, capture);
		const destination = join(state.directory, "feature-import");
		const report = await migrateSourceBucket({ ...source, destination });
		expect(report.objects).toBe(12);
		expect(report.jmapUploads).toBe(3);
		expect(report.driveParts).toBe(1);
		const db = new Database(join(destination, "mailflare.sqlite"), {
			readonly: true,
		});
		try {
			expect(
				Object.values(capture.backup.tables).every((rows) => rows.length > 0),
			).toBe(true);
			const compared = verifyOriginalRecordFields(db, capture.backup.tables);
			expect(compared.tables).toBe(43);
			expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
			console.log("Original populated features", compared);
		} finally {
			db.close();
		}
	} finally {
		await state.close();
	}
});

test("imported populated features retain the original GET contracts", async () => {
	const state = await fixture();
	try {
		const source = await prepareSourceUploads(state.directory, capture),
			destination = join(state.directory, "feature-http");
		await migrateSourceBucket({ ...source, destination });
		process.env.DATA_DIR = destination;
		const { getUser } = await import("../src/server/auth/service"),
			{ sourceFeatureSession, comparableFeatureResponse, readFeatureBody } =
				await import("./source-feature-requests"),
			{ dispatchMailApi } = await import("../src/server/api/mail");
		const user = await getUser(sourceFeatureSession);
		if (!user) throw new Error("Imported source session is unusable");
		const before = Math.floor(Date.now() / 1000);
		for (const expected of capture.featureResponses) {
			const response = await dispatchMailApi(
				new Request("https://mail.example" + expected.path),
				user,
			);
			expect(response.status).toBe(expected.status);
			expect(
				comparableFeatureResponse(
					expected.path,
					await readFeatureBody(response),
					capture.backup.tables.mailboxes.map((row) => row.id),
				),
			).toEqual(
				comparableFeatureResponse(
					expected.path,
					expected.body,
					capture.backup.tables.mailboxes.map((row) => row.id),
				),
			);
		}
		const db = new Database(join(destination, "mailflare.sqlite"));
		try {
			const boxes = db
				.query(
					"SELECT id,created_at FROM mailboxes WHERE user_id='owner' AND type='personal'",
				)
				.all() as { id: string; created_at: number }[];
			expect(boxes).toHaveLength(1);
			expect(boxes[0]!.created_at).toBeGreaterThanOrEqual(before);
			expect(boxes[0]!.created_at).toBeLessThanOrEqual(
				Math.floor(Date.now() / 1000),
			);
			await dispatchMailApi(
				new Request("https://mail.example/api/mailboxes"),
				user,
			);
			expect(
				db
					.query(
						"SELECT id,created_at FROM mailboxes WHERE user_id='owner' AND type='personal'",
					)
					.all(),
			).toEqual(boxes);
		} finally {
			db.close();
		}
	} finally {
		await state.close();
	}
});

test("a native full backup restores every populated imported table and native upload record", async () => {
	const state = await fixture();
	try {
		const source = await prepareSourceUploads(state.directory, capture),
			destination = join(state.directory, "feature-backup-import");
		await migrateSourceBucket({ ...source, destination });
		const { writeBackup, restoreBackup } = await import(
				"../src/lib/backups/export"
			),
			{ migrate } = await import("../src/server/db");
		const backup = join(state.directory, "native-feature-backup.json"),
			path = join(state.directory, "native-feature-restore.sqlite");
		await writeBackup(join(destination, "mailflare.sqlite"), backup);
		const document = await Bun.file(backup).json();
		await migrate(path);
		const db = new Database(path);
		try {
			restoreBackup(db, document);
			expect(verifyOriginalRecordFields(db, capture.backup.tables)).toEqual({
				tables: 43,
				records: 54,
				fields: 648,
			});
			for (const [table, rows] of Object.entries(document.tables)) {
				const actual = db
					.query('SELECT * FROM "' + table.replaceAll('"', '""') + '"')
					.all();
				const canonical = (values: unknown[]) =>
					values.map((row) => JSON.stringify(row)).sort();
				expect(canonical(actual)).toEqual(canonical(rows as unknown[]));
			}
			expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			db.close();
		}
	} finally {
		await state.close();
	}
});
