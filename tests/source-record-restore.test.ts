import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fixture, owner } from "./fixtures";
import { prepareSourceUploads } from "./source-upload-fixture";
import capture from "./source-record-restore-capture.json";
import { migrateSourceBucket } from "../src/server/migration/source-bucket";
import { restoreRecords } from "../src/server/backups/service";
import { finishUpload } from "../src/server/drive/uploads";
import { LocalStorage } from "../src/server/storage";

async function imported() {
	const state = await fixture();
	try {
		const source = await prepareSourceUploads(state.directory, capture),
			destination = join(state.directory, "restored-source");
		await migrateSourceBucket({ ...source, destination });
		process.env.DATA_DIR = destination;
		return { ...state, destination };
	} catch (error) {
		await state.close();
		throw error;
	}
}
test("restoring original records retains source JMAP object metadata outside the original database schema", async () => {
	const state = await imported();
	try {
		const db = new Database(join(state.destination, "mailflare.sqlite"));
		try {
			const before = db
				.query("SELECT * FROM mailrun_jmap_uploads ORDER BY id")
				.all();
			expect(before).toHaveLength(3);
			await restoreRecords(owner, capture.backup);
			expect(
				db.query("SELECT * FROM mailrun_jmap_uploads ORDER BY id").all(),
			).toEqual(before);
		} finally {
			db.close();
		}
	} finally {
		await state.close();
	}
});
test("restoring original pending Drive records retains acknowledged parts and completes with their original bytes", async () => {
	const state = await imported();
	try {
		await restoreRecords(owner, capture.backup);
		await finishUpload(owner, capture.expected.drive.id);
		expect(await new LocalStorage().file("drive/owner/pending").text()).toBe(
			"abc",
		);
	} finally {
		await state.close();
	}
});

test("legacy restore filters upload owners and can recover their metadata when that source account returns", async () => {
	const state = await imported();
	try {
		const db = new Database(join(state.destination, "mailflare.sqlite"));
		try {
			const before = db
				.query("SELECT * FROM mailrun_jmap_uploads ORDER BY id")
				.all();
			const without = structuredClone(capture.backup);
			without.tables.users = without.tables.users.filter(
				(user) => user.id !== "stranger",
			);
			without.tables.mailboxes = without.tables.mailboxes.filter(
				(box) => box.user_id !== "stranger",
			);
			await restoreRecords(owner, without);
			expect(
				db
					.query(
						"SELECT user_id FROM mailrun_jmap_uploads WHERE user_id='stranger'",
					)
					.all(),
			).toEqual([]);
			await restoreRecords(owner, capture.backup);
			expect(
				db.query("SELECT * FROM mailrun_jmap_uploads ORDER BY id").all(),
			).toEqual(before);
		} finally {
			db.close();
		}
	} finally {
		await state.close();
	}
});

test("an explicit native empty-upload snapshot clears uploads", async () => {
	const state = await imported();
	try {
		const document = {
			...capture.backup,
			tables: { ...capture.backup.tables, mailrun_jmap_uploads: [] },
		};
		await restoreRecords(owner, document);
		const db = new Database(join(state.destination, "mailflare.sqlite"));
		try {
			expect(db.query("SELECT id FROM mailrun_jmap_uploads").all()).toEqual([]);
		} finally {
			db.close();
		}
	} finally {
		await state.close();
	}
});

test("unmatched source multipart metadata is rejected before replacing database records", async () => {
	const state = await imported();
	try {
		const db = new Database(join(state.destination, "mailflare.sqlite"));
		try {
			db.exec("UPDATE users SET name='Unchanged sentinel' WHERE id='owner'");
			const altered = structuredClone(capture.backup);
			altered.tables.drive_upload_parts[0]!.etag = "another-source-part";
			await expect(restoreRecords(owner, altered)).rejects.toThrow(
				"parts that were not migrated",
			);
			expect(db.query("SELECT name FROM users WHERE id='owner'").get()).toEqual(
				{ name: "Unchanged sentinel" },
			);
			await finishUpload(owner, capture.expected.drive.id);
			expect(await new LocalStorage().file("drive/owner/pending").text()).toBe(
				"abc",
			);
		} finally {
			db.close();
		}
	} finally {
		await state.close();
	}
});

test("invalid archived upload ownership rolls back the whole database restore", async () => {
	const state = await imported();
	try {
		await restoreRecords(owner, capture.backup);
		const metadata = new LocalStorage(
			join(state.destination, "restore-object-metadata"),
		);
		const target = capture.expected.uploads.find(
			(row) => row.userId === "owner",
		)!;
		for (const key of await readdir(metadata.root, { recursive: true })) {
			if (!key.endsWith(".json")) continue;
			const value = (await metadata.file(key).json()) as {
				id: string;
				r2_key: string;
			};
			if (value.id === target.blobId.slice(3)) {
				value.r2_key = "jmap-uploads/stranger/foreign";
				await metadata.put(key, JSON.stringify(value));
			}
		}
		const db = new Database(join(state.destination, "mailflare.sqlite"));
		try {
			db.query("DELETE FROM mailrun_jmap_uploads WHERE id=?").run(
				target.blobId.slice(3),
			);
			db.exec("UPDATE users SET name='Rollback sentinel' WHERE id='owner'");
			await expect(restoreRecords(owner, capture.backup)).rejects.toThrow(
				"namespace",
			);
			expect(db.query("SELECT name FROM users WHERE id='owner'").get()).toEqual(
				{ name: "Rollback sentinel" },
			);
		} finally {
			db.close();
		}
	} finally {
		await state.close();
	}
});

test("original record restore retains the verified native email relay binding", async () => {
	const state = await imported();
	try {
		const { saveInstallation, setInstallationPhase, getInstallation } =
			await import("../src/server/cloudflare/installation");
		await saveInstallation({
			accountId: "a".repeat(32),
			zoneId: "zone",
			hostname: "example.com",
			workerName: "fixture-relay",
			publicOrigin: "https://fixture.example",
			auth: { kind: "token", token: "synthetic-relay-token" },
			relaySecret: "synthetic-relay-secret",
			relayVersion: "fixture",
		});
		await setInstallationPhase("ready");
		const before = await getInstallation(),
			db = new Database(join(state.destination, "mailflare.sqlite"));
		try {
			db.exec(
				"UPDATE domains SET routing_enabled=1,mailrun_relay_worker_name='fixture-relay',mailrun_relay_zone_id='zone' WHERE id='domain'",
			);
			const document = structuredClone(capture.backup);
			document.tables.domains[0]!.routing_enabled = 1;
			await restoreRecords(owner, document);
			expect(await getInstallation()).toEqual(before);
			expect(
				db
					.query(
						"SELECT mailrun_relay_worker_name,mailrun_relay_zone_id FROM domains WHERE id='domain'",
					)
					.get(),
			).toEqual({
				mailrun_relay_worker_name: "fixture-relay",
				mailrun_relay_zone_id: "zone",
			});
		} finally {
			db.close();
		}
	} finally {
		await state.close();
	}
});

test("an explicit native empty relay snapshot clears the native installation", async () => {
	const state = await imported();
	try {
		const { saveInstallation, getInstallation } = await import(
			"../src/server/cloudflare/installation"
		);
		await saveInstallation({
			accountId: "a".repeat(32),
			zoneId: "zone",
			hostname: "example.com",
			workerName: "fixture-relay",
			publicOrigin: "https://fixture.example",
			auth: { kind: "token", token: "synthetic" },
			relaySecret: "synthetic",
			relayVersion: "fixture",
		});
		await restoreRecords(owner, {
			...capture.backup,
			tables: { ...capture.backup.tables, mailrun_installation: [] },
		});
		expect(await getInstallation()).toBeNull();
	} finally {
		await state.close();
	}
});

test("an old native ready-installation document rebinds only its verified primary zone", async () => {
	const state = await imported();
	try {
		const { saveInstallation, setInstallationPhase, getInstallation } =
			await import("../src/server/cloudflare/installation");
		await saveInstallation({
			accountId: "a".repeat(32),
			zoneId: "zone",
			hostname: "example.com",
			workerName: "fixture-relay",
			publicOrigin: "https://fixture.example",
			auth: { kind: "token", token: "synthetic" },
			relaySecret: "synthetic",
			relayVersion: "fixture",
		});
		await setInstallationPhase("ready");
		const installation = await getInstallation();
		if (!installation) throw new Error("Fixture installation missing");
		const domain = { ...capture.backup.tables.domains[0]!, routing_enabled: 1 };
		await restoreRecords(owner, {
			...capture.backup,
			tables: {
				...capture.backup.tables,
				mailrun_installation: [installation],
				domains: [
					domain,
					{
						...domain,
						id: "other",
						hostname: "other.example.org",
						zone_id: "other-zone",
					},
				],
			},
		});
		const db = new Database(join(state.destination, "mailflare.sqlite"));
		try {
			expect(
				db
					.query(
						"SELECT mailrun_relay_worker_name FROM domains WHERE id='domain'",
					)
					.get(),
			).toEqual({ mailrun_relay_worker_name: "fixture-relay" });
			expect(
				db
					.query(
						"SELECT mailrun_relay_worker_name FROM domains WHERE id='other'",
					)
					.get(),
			).toEqual({ mailrun_relay_worker_name: null });
		} finally {
			db.close();
		}
	} finally {
		await state.close();
	}
});

test("explicit native unverified domain bindings are not inferred during restore", async () => {
	const state = await imported();
	try {
		const { saveInstallation, setInstallationPhase } = await import(
			"../src/server/cloudflare/installation"
		);
		await saveInstallation({
			accountId: "a".repeat(32),
			zoneId: "zone",
			hostname: "example.com",
			workerName: "fixture-relay",
			publicOrigin: "https://fixture.example",
			auth: { kind: "token", token: "synthetic" },
			relaySecret: "synthetic",
			relayVersion: "fixture",
		});
		await setInstallationPhase("ready");
		await restoreRecords(owner, {
			...capture.backup,
			tables: {
				...capture.backup.tables,
				domains: [
					{
						...capture.backup.tables.domains[0]!,
						routing_enabled: 1,
						mailrun_relay_worker_name: null,
						mailrun_relay_zone_id: null,
					},
				],
			},
		});
		const db = new Database(join(state.destination, "mailflare.sqlite"));
		try {
			expect(
				db
					.query(
						"SELECT mailrun_relay_worker_name FROM domains WHERE id='domain'",
					)
					.get(),
			).toEqual({ mailrun_relay_worker_name: null });
		} finally {
			db.close();
		}
	} finally {
		await state.close();
	}
});

test("legacy object metadata restore crosses a bounded page without losing uploads", async () => {
	const state = await imported();
	try {
		const db = new Database(join(state.destination, "mailflare.sqlite"));
		try {
			const storage = new LocalStorage();
			for (let i = 0; i < 501; i++) {
				const id = "paged-" + String(i).padStart(4, "0"),
					key = "jmap-uploads/owner/" + id;
				await storage.put(key, "x");
				db.query(
					"INSERT INTO mailrun_jmap_uploads(id,user_id,r2_key,content_type,name,size,created_at) VALUES(?,'owner',?,'text/plain',NULL,1,1)",
				).run(id, key);
			}
			await restoreRecords(owner, capture.backup);
			expect(
				db.query("SELECT count(*) AS total FROM mailrun_jmap_uploads").get(),
			).toEqual({ total: 504 });
			expect(
				db
					.query("SELECT id FROM mailrun_jmap_uploads WHERE id='paged-0500'")
					.get(),
			).toEqual({ id: "paged-0500" });
		} finally {
			db.close();
		}
	} finally {
		await state.close();
	}
}, 30000);
