import { resolve, join } from "node:path";
import { readFile } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { z } from "zod";
import { fixture } from "../tests/fixtures";
import { writeAvatarFixturePreload } from "../tests/avatar-provider";
import { hash } from "../src/server/auth/service";
import { seconds } from "../src/server/db";
import { LocalStorage } from "../src/server/storage";
const state = await fixture(),
	preload = await writeAvatarFixturePreload(state.directory),
	binary = resolve(process.argv[2] ?? "dist/mailrun-local"),
	token = crypto.randomUUID(),
	secret = crypto.randomUUID(),
	origin = "https://durability.fixture.example",
	attachmentSize = 17_000_003;
state.db
	.query(
		"INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES('durability','owner',?,?,?)",
	)
	.run(await hash(token), seconds() + 600, seconds());
state.db
	.query(
		"INSERT INTO mailrun_installation(id,account_id,zone_id,hostname,worker_name,public_origin,api_token,relay_secret,relay_version,phase,updated_at) VALUES('primary',?,'zone','example.com','durability-relay',?,'synthetic-cloudflare-token',?,'fixture','ready',1)",
	)
	.run("a".repeat(32), origin, secret);
state.db.exec("UPDATE users SET spam_protection_enabled=0");
const input = join(state.directory, "durability-input.eml"),
	writer = Bun.file(input).writer({ highWaterMark: 1024 * 1024 }),
	attachmentHash = createHash("sha256");
writer.write(
	[
		"From: Sender <sender@example.org>",
		"To: hello@example.com",
		"Subject: Standalone crash fixture",
		"Message-ID: <standalone-crash@example.org>",
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="durability"',
		"",
		"--durability",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Survive an abrupt process exit.",
		"--durability",
		"Content-Type: application/octet-stream",
		'Content-Disposition: attachment; filename="durable.bin"',
		"Content-Transfer-Encoding: base64",
		"",
	].join("\r\n") + "\r\n",
);
for (let offset = 0; offset < attachmentSize; offset += 48 * 1024) {
	const chunk = new Uint8Array(
		Math.min(48 * 1024, attachmentSize - offset),
	).fill(42);
	attachmentHash.update(chunk);
	writer.write(
		Buffer.from(chunk)
			.toString("base64")
			.replace(/.{1,76}/g, "$&\r\n"),
	);
	if (offset % (1024 * 1024) < 48 * 1024) await writer.flush();
}
writer.write("--durability--\r\n");
await writer.end();
const expectedAttachmentHash = attachmentHash.digest("hex");
async function digest(file: Blob | ReadableStream<Uint8Array>) {
	const hash = createHash("sha256");
	for await (const chunk of file instanceof Blob ? file.stream() : file)
		hash.update(chunk);
	return hash.digest("hex");
}
const expectedRawHash = await digest(Bun.file(input));
const env = {
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	TMPDIR: process.env.TMPDIR,
	DATA_DIR: state.directory,
	HOST: "127.0.0.1",
	PORT: "0",
	APP_URL: origin,
	BUN_OPTIONS: "--preload " + preload.path,
};
let child: ReturnType<typeof Bun.spawn> | undefined,
	base = "",
	maxObservedRssKiB = 0,
	sampler: ReturnType<typeof setInterval> | undefined;
const errors: Promise<string>[] = [];
let phase = "startup";
const phaseRss: Record<string, number> = {};
async function sample() {
	if (process.platform !== "linux" || !child) return;
	const status = await readFile(`/proc/${child.pid}/status`, "utf8").catch(
		() => "",
	);
	const value = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0);
	maxObservedRssKiB = Math.max(maxObservedRssKiB, value);
	phaseRss[phase] = Math.max(phaseRss[phase] ?? 0, value);
}
async function start() {
	child = Bun.spawn([binary], {
		cwd: state.directory,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (
		!child.stdout ||
		typeof child.stdout === "number" ||
		typeof child.stderr === "number"
	)
		throw new Error("Missing fixture output pipes");
	errors.push(new Response(child.stderr).text());
	const reader = child.stdout.getReader();
	let output = "",
		timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			(async () => {
				for (;;) {
					const next = await reader.read();
					if (next.done)
						throw new Error("Durability server exited before listening");
					output += new TextDecoder().decode(next.value);
					const found = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
					if (found) {
						base = found;
						break;
					}
				}
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Durability server did not boot")),
					10_000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
	if (!existsSync(preload.marker))
		throw new Error("Isolated network fixture was not loaded");
	sampler = setInterval(() => {
		void sample();
	}, 20);
}
async function stop(signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
	clearInterval(sampler);
	await sample();
	if (child) {
		child.kill(signal);
		await child.exited;
		child = undefined;
	}
}
async function intake() {
	const timestamp = String(Date.now()),
		hmac = createHmac("sha256", secret).update(
			timestamp + "\nsender@example.org\nhello@example.com\n",
		);
	for await (const chunk of Bun.file(input).stream()) hmac.update(chunk);
	const response = await fetch(base + "/api/inbound", {
		method: "POST",
		headers: {
			"X-Mailrun-Timestamp": timestamp,
			"X-Mailrun-Signature": hmac.digest("hex"),
			"X-Mailrun-From": "sender@example.org",
			"X-Mailrun-To": "hello@example.com",
			"X-Mailrun-Relay": "2",
		},
		body: Bun.file(input),
	});
	if (!response.ok)
		throw new Error(
			"Inbound request failed: " +
				response.status +
				" " +
				(await response.text()),
		);
	return z
		.object({ action: z.literal("store"), messageId: z.string() })
		.parse(await response.json());
}
try {
	await start();
	phase = "receive";
	const accepted = await intake();
	await stop("SIGKILL");
	// Restart from the same files without a graceful shutdown/checkpoint hook.
	phase = "restart";
	await start();
	const message = z
		.object({ raw_r2_key: z.string() })
		.parse(
			state.db
				.query("SELECT raw_r2_key FROM messages WHERE id=?")
				.get(accepted.messageId),
		);
	const attachment = z
		.object({ r2_key: z.string(), size: z.number() })
		.parse(
			state.db
				.query("SELECT r2_key,size FROM message_attachments WHERE message_id=?")
				.get(accepted.messageId),
		);
	const storage = new LocalStorage();
	if (
		(await digest(storage.file(message.raw_r2_key))) !== expectedRawHash ||
		(await digest(storage.file(attachment.r2_key))) !==
			expectedAttachmentHash ||
		attachment.size !== attachmentSize
	)
		throw new Error(
			"Acknowledged MIME/attachment bytes did not survive SIGKILL",
		);
	phase = "download";
	const download = await fetch(
		base +
			`/api/messages/${accepted.messageId}/attachments/` +
			z
				.object({ id: z.string() })
				.parse(
					state.db
						.query("SELECT id FROM message_attachments WHERE message_id=?")
						.get(accepted.messageId),
				).id,
		{ headers: { Cookie: "ep_session=" + token } },
	);
	if (
		!download.ok ||
		!download.body ||
		(await digest(download.body)) !== expectedAttachmentHash
	)
		throw new Error("Restored attachment cannot be downloaded");
	phase = "replay";
	const replay = await intake();
	if (
		replay.messageId !== accepted.messageId ||
		state.db
			.query("SELECT id FROM messages WHERE subject='Standalone crash fixture'")
			.all().length !== 1 ||
		state.db
			.query("SELECT id FROM message_attachments WHERE message_id=?")
			.all(accepted.messageId).length !== 1
	)
		throw new Error("Replay duplicated acknowledged mail after restart");
	if (
		!z
			.object({ integrity_check: z.literal("ok") })
			.safeParse(state.db.query("PRAGMA integrity_check").get()).success
	)
		throw new Error("Database integrity check failed after restart");
	console.log(
		JSON.stringify(
			{
				acknowledgedMailSurvivesSigkill: "passed",
				exactRawMime: "passed",
				exactAttachmentBytes: "passed",
				authenticatedDownload: "passed",
				replayAfterRestart: "passed",
				sqliteIntegrity: "passed",
				attachmentBytes: attachmentSize,
				...(process.platform === "linux"
					? {
							linuxContainerRssObservedMiB: Math.ceil(maxObservedRssKiB / 1024),
							linuxContainerPhaseRssMiB: Object.fromEntries(
								Object.entries(phaseRss).map(([key, value]) => [
									key,
									Math.ceil(value / 1024),
								]),
							),
						}
					: {}),
				externalRequests: 0,
			},
			null,
			2,
		),
	);
} finally {
	await stop();
	await state.close();
	const stderr = (await Promise.all(errors)).join("\n");
	if (stderr.trim()) console.error(stderr);
}
