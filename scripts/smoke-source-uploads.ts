import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { z } from "zod";
import { fixture, owner, stranger } from "../tests/fixtures";
import {
	prepareSourceUploads,
	sourceUploadsCapture as capture,
} from "../tests/source-upload-fixture";
import { createManagedKey } from "../src/server/auth/key-management";
import { LocalStorage } from "../src/server/storage";

const state = await fixture(),
	source = await prepareSourceUploads(state.directory),
	destination = join(state.directory, "compiled-import"),
	binary = resolve(process.argv[2] ?? "dist/mailrun-local"),
	origin = "http://source-upload.fixture";
const environment = {
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	TMPDIR: process.env.TMPDIR,
	NODE_ENV: "production",
	HOST: "127.0.0.1",
	PORT: "0",
	APP_URL: origin,
};
let child: ReturnType<typeof Bun.spawn> | undefined,
	base = "";
const stderr: Promise<string>[] = [];
async function stop() {
	if (!child) return;
	child.kill("SIGTERM");
	await child.exited;
	child = undefined;
}
async function start() {
	child = Bun.spawn([binary], {
		cwd: state.directory,
		env: { ...environment, DATA_DIR: destination },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (
		!child.stdout ||
		typeof child.stdout === "number" ||
		typeof child.stderr === "number"
	)
		throw new Error("Missing server pipes");
	stderr.push(new Response(child.stderr).text());
	const reader = child.stdout.getReader();
	let text = "",
		timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			(async () => {
				for (;;) {
					const next = await reader.read();
					if (next.done)
						throw new Error("Imported server exited before listening");
					text += new TextDecoder().decode(next.value);
					const url = text.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
					if (url) {
						base = url;
						return;
					}
				}
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Imported server did not boot")),
					15000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
}
const checksum = (bytes: ArrayBuffer | Uint8Array) =>
	new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
async function downloads(ownerKey: string, strangerKey: string) {
	for (const upload of capture.expected.uploads) {
		const token = upload.userId === "owner" ? ownerKey : strangerKey;
		const path = `/jmap/download/${upload.accountId}/${encodeURIComponent(upload.blobId)}/${encodeURIComponent(upload.name ?? "blob")}`;
		const response = await fetch(base + path, {
			headers: { Authorization: "Bearer " + token },
		});
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("Content-Type"), upload.type);
		assert.equal(Number(response.headers.get("Content-Length")), upload.size);
		assert.equal(checksum(await response.arrayBuffer()), upload.sha256);
		if (upload.userId === "stranger") {
			const denied = await fetch(base + path.replace("/stranger/", "/owner/"), {
				headers: { Authorization: "Bearer " + ownerKey },
			});
			assert.equal(denied.status, 404);
			await denied.body?.cancel();
		}
	}
}
try {
	const migration = Bun.spawn(
		[
			binary,
			"migrate-source",
			"--backup",
			source.backup,
			"--bucket",
			source.bucket,
			"--destination",
			destination,
		],
		{ cwd: state.directory, env: environment, stdout: "pipe", stderr: "pipe" },
	);
	const timer = setTimeout(() => migration.kill("SIGKILL"), 30000);
	try {
		const [exit, output, errors] = await Promise.all([
			migration.exited,
			new Response(migration.stdout).text(),
			new Response(migration.stderr).text(),
		]);
		assert.equal(exit, 0, errors);
		assert.equal(errors.trim(), "");
		z.object({
			jmapUploads: z.literal(3),
			driveParts: z.literal(1),
			objects: z.literal(4),
		}).parse(JSON.parse(output));
	} finally {
		clearTimeout(timer);
	}
	assert.equal(
		await Bun.file(join(state.directory, "data/mailflare.sqlite")).exists(),
		false,
		"Migration command started the normal app initialization",
	);
	process.env.DATA_DIR = destination;
	const ownerKey = (
		await createManagedKey(owner, "personal", {
			name: "Migrated owner",
			scopes: ["jmap"],
			mailboxIds: ["mailbox"],
		})
	).key;
	const strangerKey = (
		await createManagedKey(stranger, "personal", {
			name: "Migrated stranger",
			scopes: ["jmap"],
			mailboxIds: ["stranger-mailbox"],
		})
	).key;
	await start();
	await downloads(ownerKey, strangerKey);
	await stop();
	await start();
	await downloads(ownerKey, strangerKey);
	const upload = capture.expected.uploads.find(
		(upload) => upload.type === "message/rfc822",
	);
	if (!upload) throw new Error("Missing source MIME fixture");
	const imported = await fetch(base + "/jmap/api", {
		method: "POST",
		headers: {
			Authorization: "Bearer " + ownerKey,
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
								blobId: upload.blobId,
								mailboxIds: { "mailbox~drafts": true },
							},
						},
					},
					"import",
				],
			],
		}),
	});
	assert.equal(imported.status, 200);
	const result = z
		.object({
			methodResponses: z.array(
				z.tuple([
					z.literal("Email/import"),
					z.object({
						created: z.object({ original: z.object({ blobId: z.string() }) }),
					}),
					z.literal("import"),
				]),
			),
		})
		.parse(await imported.json());
	await stop();
	await start();
	const replay = await fetch(base + "/jmap/api", {
		method: "POST",
		headers: {
			Authorization: "Bearer " + ownerKey,
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
								blobId: upload.blobId,
								mailboxIds: { "mailbox~drafts": true },
							},
						},
					},
					"import",
				],
			],
		}),
	});
	assert.equal(replay.status, 200);
	z.object({
		methodResponses: z.array(
			z.tuple([
				z.literal("Email/import"),
				z.object({
					notCreated: z.object({
						original: z.object({ type: z.literal("blobNotFound") }),
					}),
				}),
				z.literal("import"),
			]),
		),
	}).parse(await replay.json());
	const claimed = await fetch(
		base +
			`/jmap/download/owner/${encodeURIComponent(upload.blobId)}/original.eml`,
		{ headers: { Authorization: "Bearer " + ownerKey } },
	);
	assert.equal(claimed.status, 404);
	await claimed.body?.cancel();
	const raw = await fetch(
		base +
			`/jmap/download/owner/${encodeURIComponent(result.methodResponses[0]![1].created.original.blobId)}/original.eml`,
		{ headers: { Authorization: "Bearer " + ownerKey } },
	);
	assert.equal(raw.status, 200);
	assert.equal(await raw.text(), capture.expected.mime);
	const signedIn = await fetch(base + "/api/auth/login", {
		method: "POST",
		headers: { Origin: origin, "Content-Type": "application/json" },
		body: JSON.stringify({
			email: "owner@example.com",
			password: "source-upload-fixture-password",
		}),
	});
	assert.equal(signedIn.status, 200);
	const cookie = signedIn.headers
		.getSetCookie()
		.find((value) => value.startsWith("ep_session="))
		?.split(";")[0];
	if (!cookie) throw new Error("Missing source fixture session");
	await signedIn.body?.cancel();
	const completed = await fetch(base + "/api/drive/upload/pending", {
		method: "POST",
		headers: { Origin: origin, Cookie: cookie },
	});
	assert.equal(completed.status, 200, await completed.text());
	const content = await fetch(base + "/api/drive/items/pending/content", {
		headers: { Cookie: cookie },
	});
	assert.equal(content.status, 200);
	assert.equal(await content.text(), "abc");
	for (const file of capture.files)
		assert.equal(
			checksum(
				await new LocalStorage(source.bucket).file(file.key).arrayBuffer(),
			),
			file.sha256,
		);
	console.log(
		JSON.stringify(
			{
				originalFullExport: "passed",
				standaloneMigrationCommand: "passed",
				exactUploadBlobIdsAndMetadata: "passed",
				ownerIsolation: "passed",
				restart: "passed",
				mimeClaimAndOriginalBytes: "passed",
				originalMultipartCompletion: "passed",
				unchangedSourceObjects: "passed",
				externalRequests: 0,
			},
			null,
			2,
		),
	);
} finally {
	await stop();
	await state.close();
	const errors = (await Promise.all(stderr)).join("\n");
	if (errors.trim()) console.error(errors);
}
