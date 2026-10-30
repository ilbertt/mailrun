import { Database } from "bun:sqlite";
import { z } from "zod";
import { test, expect } from "bun:test";
import { join } from "node:path";
import { lstat, readdir, symlink } from "node:fs/promises";
import { fixture, owner } from "./fixtures";
import { writeBackup } from "../src/lib/backups/export";
import { LocalStorage } from "../src/server/storage";
import { migrateSourceBucket } from "../src/server/migration/source-bucket";
import { createManagedKey } from "../src/server/auth/key-management";
import { handleJmapRequest } from "../src/server/jmap/handler";
import { startUpload, finishUpload } from "../src/server/drive/uploads";
import {
	prepareSourceUploads,
	sourceUploadsCapture,
	verifyOriginalRecordFields,
} from "./source-upload-fixture";

test("unmodified source uploader, FileBucket multipart parts and original full export migrate without changing client blob IDs", async () => {
	const state = await fixture();
	try {
		const source = await prepareSourceUploads(state.directory),
			destination = join(state.directory, "captured-import");
		expect(await migrateSourceBucket({ ...source, destination })).toMatchObject(
			{ objects: 7, jmapUploads: 3, driveParts: 1 },
		);
		process.env.DATA_DIR = destination;
		const records = new Database(join(destination, "mailflare.sqlite"), {
			readonly: true,
		});
		try {
			expect(verifyOriginalRecordFields(records).records).toBeGreaterThan(0);
		} finally {
			records.close();
		}
		const key = (
			await createManagedKey(owner, "personal", {
				name: "Migrated client",
				scopes: ["jmap"],
				mailboxIds: ["mailbox"],
			})
		).key;
		for (const upload of sourceUploadsCapture.expected.uploads) {
			const response = await handleJmapRequest(
				request(
					key,
					`/jmap/download/owner/${encodeURIComponent(upload.blobId)}/`,
				),
			);
			if (upload.userId !== "owner") {
				expect(response.status).toBe(404);
				continue;
			}
			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe(upload.type);
			expect(
				new Bun.CryptoHasher("sha256")
					.update(await response.arrayBuffer())
					.digest("hex"),
			).toBe(upload.sha256);
		}
		await finishUpload(owner, sourceUploadsCapture.expected.drive.id);
		expect(await new LocalStorage().file("drive/owner/pending").text()).toBe(
			"abc",
		);
		for (const file of sourceUploadsCapture.files)
			expect(
				new Bun.CryptoHasher("sha256")
					.update(
						await new LocalStorage(source.bucket).file(file.key).arrayBuffer(),
					)
					.digest("hex"),
			).toBe(file.sha256);
	} finally {
		await state.close();
	}
}, 30000);

const mime =
	"From: hello@example.com\r\nTo: hello@example.com\r\nSubject: Preserved upload\r\nMessage-ID: <source-upload@example.org>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nOriginal café\r\n";
async function sourceFixture() {
	const state = await fixture(),
		bucket = join(state.directory, "source-bucket"),
		store = new LocalStorage(bucket),
		backup = join(state.directory, "source-records.json"),
		destination = join(state.directory, "imported");
	const key = (
		await createManagedKey(owner, "personal", {
			name: "Original client",
			scopes: ["jmap"],
			mailboxIds: ["mailbox"],
		})
	).key;
	await store.put("jmap-uploads/owner/source-upload", mime);
	await store.put(
		"jmap-uploads/owner/source-upload.meta.json",
		JSON.stringify({
			size: Buffer.byteLength(mime),
			uploaded: "2026-10-29T10:00:00.000Z",
			httpMetadata: { contentType: "message/rfc822" },
			customMetadata: { userId: "stranger", name: "Original café.eml" },
		}),
	);
	await store.put(
		"jmap-uploads/stranger/private-upload",
		"Private source bytes",
	);
	await store.put(
		"jmap-uploads/deleted-user/orphan",
		"Unreachable source bytes",
	);
	await store.put("avatars/original-preview.png", "Source preview bytes");
	const now = Math.floor(Date.now() / 1000);
	state.db
		.query(
			"INSERT INTO drive_items(id,owner_id,kind,name,r2_key,size,content_type,upload_id,upload_part_size,upload_fingerprint,created_at,updated_at) VALUES('pending','owner','file','pending.txt','drive/owner/pending',3,'text/plain','source-upload-id',67108864,'original-fingerprint',?,?)",
		)
		.run(now, now);
	state.db.exec(
		"INSERT INTO drive_upload_parts(item_id,part_number,etag) VALUES('pending',1,'1-3')",
	);
	await store.put(".multipart/source-upload-id/part-1", "abc");
	await store.put(
		".multipart/source-upload-id/meta.json",
		JSON.stringify({ contentType: "text/plain" }),
	);
	await writeBackup(state.path, backup);
	return { ...state, bucket, store, backup, destination, key };
}
const request = (key: string, path: string) =>
	new Request("https://fixture.example" + path, {
		headers: { Authorization: "Bearer " + key },
	});

test("source upload metadata and multipart parts survive offline import and remain usable through native JMAP and Drive", async () => {
	const state = await sourceFixture();
	try {
		expect(await migrateSourceBucket(state)).toMatchObject({
			objects: 4,
			jmapUploads: 2,
			orphanJmapUploads: 1,
			driveParts: 1,
		});
		expect((await lstat(state.destination)).mode & 0o777).toBe(0o700);
		expect(
			(await lstat(join(state.destination, "mailflare.sqlite"))).mode & 0o777,
		).toBe(0o600);
		process.env.DATA_DIR = state.destination;
		const migrated = new Database(join(state.destination, "mailflare.sqlite"));
		try {
			expect(
				migrated
					.query(
						"SELECT id,user_id,content_type,name,size,created_at FROM mailrun_jmap_uploads WHERE id='source-upload'",
					)
					.get(),
			).toEqual({
				id: "source-upload",
				user_id: "owner",
				content_type: "message/rfc822",
				name: "Original café.eml",
				size: Buffer.byteLength(mime),
				created_at: 1793268000,
			});
			expect(
				migrated
					.query(
						"SELECT content_type,name FROM mailrun_jmap_uploads WHERE id='private-upload'",
					)
					.get(),
			).toEqual({ content_type: "application/octet-stream", name: null });
			const downloaded = await handleJmapRequest(
				request(state.key, "/jmap/download/owner/up~source-upload/"),
			);
			expect(downloaded.status).toBe(200);
			expect(downloaded.headers.get("Content-Type")).toBe("message/rfc822");
			expect(downloaded.headers.get("Content-Disposition")).toContain(
				"Original%20caf%C3%A9.eml",
			);
			expect(await downloaded.text()).toBe(mime);
			expect(
				(
					await handleJmapRequest(
						request(state.key, "/jmap/download/owner/up~private-upload/"),
					)
				).status,
			).toBe(404);
			expect(
				(
					await handleJmapRequest(
						request(state.key, "/jmap/download/stranger/up~private-upload/"),
					)
				).status,
			).toBe(404);
			const imported = await handleJmapRequest(
				new Request("https://fixture.example/jmap/api", {
					method: "POST",
					headers: {
						Authorization: "Bearer " + state.key,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
						methodCalls: [
							[
								"Email/import",
								{
									emails: {
										original: {
											blobId: "up~source-upload",
											mailboxIds: { "mailbox~drafts": true },
										},
									},
								},
								"import",
							],
						],
					}),
				}),
			);
			expect(imported.status).toBe(200);
			const result = z
				.object({
					methodResponses: z.array(
						z.tuple([
							z.literal("Email/import"),
							z.object({
								created: z.object({
									original: z.object({ id: z.string().min(1) }),
								}),
							}),
							z.literal("import"),
						]),
					),
				})
				.parse(await imported.json());
			expect(result.methodResponses).toHaveLength(1);
			expect(
				migrated
					.query("SELECT id FROM mailrun_jmap_uploads WHERE id='source-upload'")
					.get(),
			).toBeNull();
			expect(
				migrated
					.query(
						"SELECT subject FROM messages WHERE provider_message_id='<source-upload@example.org>'",
					)
					.get(),
			).toEqual({ subject: "Preserved upload" });
			const resumed = await startUpload(owner, {
				name: "pending.txt",
				size: 3,
				contentType: "text/plain",
				fingerprint: "original-fingerprint",
			});
			expect(resumed).toMatchObject({
				id: "pending",
				resumed: true,
				uploaded: [1],
			});
			await finishUpload(owner, "pending");
			expect(await new LocalStorage().file("drive/owner/pending").text()).toBe(
				"abc",
			);
			expect(
				migrated
					.query("SELECT upload_id FROM drive_items WHERE id='pending'")
					.get(),
			).toEqual({ upload_id: null });
			expect(
				await new LocalStorage().file("avatars/original-preview.png").text(),
			).toBe("Source preview bytes");
			expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			migrated.close();
		}
		// Import and subsequent claims never mutate the frozen source bytes.
		expect(
			await state.store.file("jmap-uploads/owner/source-upload").text(),
		).toBe(mime);
		expect(
			await state.store.file(".multipart/source-upload-id/part-1").text(),
		).toBe("abc");
	} finally {
		await state.close();
	}
}, 30000);

test("missing source objects, invalid metadata and symlinks fail without publishing a partial target; repaired input can be retried", async () => {
	const state = await sourceFixture();
	try {
		await state.store.put(
			"jmap-uploads/owner/source-upload.meta.json",
			JSON.stringify({ size: 1 }),
		);
		await expect(migrateSourceBucket(state)).rejects.toThrow(
			"metadata size mismatch",
		);
		expect(
			await Bun.file(join(state.destination, "mailflare.sqlite")).exists(),
		).toBe(false);
		expect(
			(await readdir(state.directory)).some((name) =>
				name.startsWith(".mailrun-source-migration-"),
			),
		).toBe(false);
		await state.store.delete("jmap-uploads/owner/source-upload.meta.json");
		await symlink(
			join(state.directory, "mailflare.sqlite"),
			join(state.bucket, "unsafe-link"),
		);
		await expect(migrateSourceBucket(state)).rejects.toThrow("symbolic link");
		await state.store.delete("unsafe-link");
		state.db.exec("UPDATE messages SET raw_r2_key='inbound/missing.eml'");
		await writeBackup(state.path, state.backup);
		await expect(migrateSourceBucket(state)).rejects.toThrow(
			"missing a referenced object",
		);
		await state.store.put("inbound/missing.eml", "Restored source raw MIME");
		expect((await migrateSourceBucket(state)).jmapUploads).toBe(2);
		await expect(migrateSourceBucket(state)).rejects.toMatchObject({
			code: "EEXIST",
		});
		expect(
			await new LocalStorage(join(state.destination, "blobs"))
				.file("inbound/missing.eml")
				.text(),
		).toBe("Restored source raw MIME");
	} finally {
		await state.close();
	}
}, 30000);
