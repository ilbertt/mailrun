import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { fixture } from "../tests/fixtures";
import {
	prepareSourceUploads,
	verifyOriginalRecordFields,
} from "../tests/source-upload-fixture";
import capture from "../tests/source-record-restore-capture.json";

const state = await fixture(),
	source = await prepareSourceUploads(state.directory, capture),
	destination = join(state.directory, "compiled-record-restore"),
	binary = resolve(process.argv[2] ?? "dist/mailrun-local"),
	origin = "http://source-record-restore.fixture";
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
			objects: z.literal(7),
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
	const records = new Database(join(destination, "mailflare.sqlite"), {
		readonly: true,
	});
	let originalFields: ReturnType<typeof verifyOriginalRecordFields>;
	try {
		originalFields = verifyOriginalRecordFields(records, capture.backup.tables);
	} finally {
		records.close();
	}

	const relay = {
		worker_name: "fixture-relay",
		relay_secret: "synthetic-relay-secret",
		api_token: "synthetic-relay-token",
		phase: "ready",
	};
	const config = new Database(join(destination, "mailflare.sqlite"));
	try {
		config
			.query(
				"INSERT INTO mailrun_installation(id,account_id,zone_id,hostname,worker_name,public_origin,api_token,relay_secret,relay_version,phase,updated_at) VALUES('primary',?,'zone','example.com',?,?,?,?,'fixture','ready',1)",
			)
			.run(
				"a".repeat(32),
				relay.worker_name,
				origin,
				relay.api_token,
				relay.relay_secret,
			);
		config.exec(
			"UPDATE domains SET mailrun_relay_worker_name='fixture-relay',mailrun_relay_zone_id='zone' WHERE id='domain'",
		);
	} finally {
		config.close();
	}

	await start();
	async function login(email: string) {
		const response = await fetch(base + "/api/auth/login", {
			method: "POST",
			headers: { Origin: origin, "Content-Type": "application/json" },
			body: JSON.stringify({
				email,
				password: "source-upload-fixture-password",
			}),
			signal: AbortSignal.timeout(30000),
		});
		assert.equal(response.status, 200);
		return z.object({ token: z.string() }).parse(await response.json()).token;
	}
	let ownerSession = await login("owner@example.com");
	const form = new FormData();
	form.set(
		"backup",
		new File([JSON.stringify(capture.backup)], "original.json", {
			type: "application/json",
		}),
	);
	const restored = await fetch(base + "/api/backups/restore", {
		method: "POST",
		headers: { Origin: origin, Authorization: "Bearer " + ownerSession },
		body: form,
		signal: AbortSignal.timeout(30000),
	});
	assert.equal(restored.status, 200, await restored.text());
	const restoredConfig = new Database(join(destination, "mailflare.sqlite"));
	try {
		assert.deepEqual(
			restoredConfig
				.query(
					"SELECT worker_name,relay_secret,api_token,phase FROM mailrun_installation WHERE id='primary'",
				)
				.get(),
			relay,
		);
		assert.deepEqual(
			restoredConfig
				.query(
					"SELECT mailrun_relay_worker_name,mailrun_relay_zone_id FROM domains WHERE id='domain'",
				)
				.get(),
			{
				mailrun_relay_worker_name: "fixture-relay",
				mailrun_relay_zone_id: "zone",
			},
		);
	} finally {
		restoredConfig.close();
	}

	const oldSession = await fetch(base + "/api/auth/me", {
		headers: { Authorization: "Bearer " + ownerSession },
	});
	assert.equal(oldSession.status, 401);
	await oldSession.body?.cancel();
	ownerSession = await login("owner@example.com");
	const strangerSession = await login("stranger@example.com");
	const keys: Record<string, string> = {};
	for (const [user, session, mailbox] of [
		["owner", ownerSession, "mailbox"],
		["stranger", strangerSession, "stranger-mailbox"],
	] as const) {
		const response = await fetch(base + "/api/api-keys", {
			method: "POST",
			headers: {
				Origin: origin,
				Authorization: "Bearer " + session,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				name: "Restored client",
				scopes: ["jmap"],
				mailboxIds: [mailbox],
			}),
		});
		assert.equal(response.status, 200);
		keys[user] = z.object({ key: z.string() }).parse(await response.json()).key;
	}
	const checksum = (bytes: ArrayBuffer) =>
		new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	let downloads = 0;
	async function checkUploads() {
		for (const upload of capture.expected.restoredObjects.uploads) {
			const path = `/jmap/download/${upload.userId}/${encodeURIComponent(upload.blobId)}/${encodeURIComponent(upload.name ?? "blob")}`;
			const response = await fetch(base + path, {
				headers: { Authorization: "Bearer " + keys[upload.userId] },
				signal: AbortSignal.timeout(30000),
			});
			assert.equal(response.status, 200);
			assert.equal(response.headers.get("Content-Type"), upload.type);
			assert.equal(checksum(await response.arrayBuffer()), upload.sha256);
			downloads++;
			if (upload.userId === "stranger") {
				const denied = await fetch(
					base + path.replace("/stranger/", "/owner/"),
					{ headers: { Authorization: "Bearer " + keys.owner } },
				);
				assert.equal(denied.status, 404);
				await denied.body?.cancel();
			}
		}
	}
	await checkUploads();
	await stop();
	await start();
	await checkUploads();
	const complete = await fetch(
		base + "/api/drive/upload/" + capture.expected.restoredObjects.drive.id,
		{
			method: "POST",
			headers: { Origin: origin, Authorization: "Bearer " + ownerSession },
			signal: AbortSignal.timeout(30000),
		},
	);
	assert.equal(complete.status, 200, await complete.text());
	async function checkDrive() {
		const response = await fetch(
			base +
				"/api/drive/items/" +
				capture.expected.restoredObjects.drive.id +
				"/content",
			{
				headers: { Authorization: "Bearer " + ownerSession },
				signal: AbortSignal.timeout(30000),
			},
		);
		assert.equal(response.status, 200);
		const bytes = await response.arrayBuffer();
		assert.equal(bytes.byteLength, capture.expected.restoredObjects.drive.size);
		assert.equal(
			checksum(bytes),
			capture.expected.restoredObjects.drive.sha256,
		);
	}
	await checkDrive();
	await stop();
	await start();
	await checkDrive();
	await checkUploads();
	for (const file of capture.files)
		assert.equal(
			checksum(await Bun.file(join(source.bucket, file.key)).arrayBuffer()),
			file.sha256,
		);
	console.log(
		JSON.stringify(
			{
				binary,
				originalFields,
				originalRestore: "passed",
				relayConfiguration: "passed",
				reloginAfterRestore: "passed",
				jmapDownloads: downloads,
				crossUserDenial: "passed",
				driveCompletionAndRestart: "passed",
				unchangedSourceObjects: "passed",
				externalEmail: 0,
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
