import { z } from "zod";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { deepStrictEqual } from "node:assert";
import { fixture } from "../tests/fixtures";
import {
	autoReplySamples,
	prepareAutoReply,
	autoReplyInput,
	autoReplySnapshot,
} from "../tests/auto-reply-fixture";
import capture from "../tests/source-auto-reply-contracts.json";
import { startSendProvider } from "../tests/send-provider";
import { normalizeEmailAddress } from "../src/lib/email/address";
import { signRelay } from "../src/shared/relay-signature";
import { queueAutoReply } from "../src/server/mail/auto-reply";
const state = await fixture(),
	binary = resolve(process.argv[2] ?? "dist/mailrun-local"),
	origin = "https://auto-reply-fixture.example",
	provider = await startSendProvider(state.directory);
state.db.exec("PRAGMA busy_timeout=5000");
const secret = crypto.randomUUID();
const environment = {
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	TMPDIR: process.env.TMPDIR,
	DATA_DIR: state.directory,
	HOST: "127.0.0.1",
	PORT: "0",
	APP_URL: origin,
	NODE_ENV: "production",
	NODE_EXTRA_CA_CERTS: provider.cert,
	BUN_OPTIONS: "--preload " + provider.preload,
};
let child: ReturnType<typeof Bun.spawn> | undefined,
	errors: Promise<string> | undefined,
	base = "";
async function start() {
	child = Bun.spawn([binary], {
		cwd: state.directory,
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (
		!child.stdout ||
		typeof child.stdout === "number" ||
		!child.stderr ||
		typeof child.stderr === "number"
	)
		throw new Error("No fixture streams");
	errors = new Response(child.stderr).text();
	const reader = child.stdout.getReader();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			(async () => {
				let text = "";
				base = "";
				while (!base) {
					const part = await reader.read();
					if (part.done) throw new Error("Send fixture exited");
					text += new TextDecoder().decode(part.value);
					base = text.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? "";
				}
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Send fixture did not boot")),
					15000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
}
async function stop() {
	if (child) {
		child.kill("SIGTERM");
		await child.exited;
		child = undefined;
	}
	const log = await errors;
	if (log) console.error(log);
	errors = undefined;
}

const outcomeSchema = z.object({
	snapshot: z.object({
		messages: z.array(
			z.object({ id: z.string(), direction: z.string() }).passthrough(),
		),
		jobs: z.array(z.unknown()),
		deliveries: z.array(z.unknown()),
	}),
	records: z.array(z.unknown()),
});
function outcome(value: unknown) {
	const parsed = outcomeSchema.parse(value),
		messages = parsed.snapshot.messages.filter(
			(row) => row.direction === "outbound",
		);
	const ids = new Map(
		messages.map((row, index) => [row.id, "$reply-" + (index + 1)]),
	);
	function normalize(value: unknown): unknown {
		if (typeof value === "string") return ids.get(value) ?? value;
		if (Array.isArray(value)) return value.map(normalize);
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([k, v]) => [k, normalize(v)]),
			);
		return value;
	}
	return normalize({
		messages,
		jobs: parsed.snapshot.jobs,
		deliveries: parsed.snapshot.deliveries,
		records: parsed.records,
	});
}
async function intake(
	sample: (typeof autoReplySamples)[number],
	messageId?: string,
) {
	const input = autoReplyInput(sample),
		from = normalizeEmailAddress(input.fromAddress),
		to = normalizeEmailAddress(input.deliveredAddress);
	const parent = messageId ?? input.incomingMessageId;
	const raw = new TextEncoder().encode(
		[
			"From: " + input.fromAddress,
			"To: " + to,
			"Subject: Synthetic automatic reply",
			...(parent ? ["Message-ID: " + parent] : []),
			...Object.entries(input.headers).map(
				([key, value]) => key + ": " + value,
			),
			"Content-Type: text/plain; charset=utf-8",
			"",
			"Synthetic incoming body",
		].join("\r\n"),
	);
	const timestamp = String(Date.now());
	return fetch(base + "/api/inbound", {
		method: "POST",
		headers: {
			"X-Mailrun-From": from,
			"X-Mailrun-To": to,
			"X-Mailrun-Relay": "2",
			"X-Mailrun-Timestamp": timestamp,
			"X-Mailrun-Signature": await signRelay(secret, timestamp, from, to, raw),
		},
		body: raw,
		signal: AbortSignal.timeout(15000),
	});
}
async function cron() {
	const child = Bun.spawn([binary, "jobs", "scheduled"], {
		cwd: state.directory,
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (await child.exited)
		throw new Error("Automatic reply cron failed: " + err);
	return out;
}
try {
	await start();
	if (!existsSync(provider.marker))
		throw new Error("Automatic-reply network isolation did not load");
	let passed = 0;
	const failures: string[] = [];
	for (const sample of autoReplySamples) {
		const expected = capture.cases.find((x) => x.name === sample.name);
		if (!expected) throw new Error("Missing original automatic reply");
		await prepareAutoReply(state.db, state.directory, sample);
		state.db.exec("UPDATE users SET spam_protection_enabled=0");
		state.db
			.query("UPDATE mailrun_installation SET relay_secret=?")
			.run(secret);
		provider.reset(sample.failure);
		const started = Math.floor(Date.now() / 1000),
			response = await intake(sample);
		try {
			deepStrictEqual(response.status, 200);
			const stored = z
				.array(z.object({ raw_r2_key: z.string() }))
				.parse(
					state.db
						.query("SELECT raw_r2_key FROM messages WHERE direction='inbound'")
						.all(),
				);
			deepStrictEqual(stored.length, 1);
			deepStrictEqual(
				await Bun.file(
					join(state.directory, "blobs", stored[0]!.raw_r2_key),
				).exists(),
				true,
			);
			deepStrictEqual(
				outcome(
					await autoReplySnapshot(
						state.db,
						state.directory,
						response,
						started,
						provider.deliveries,
					),
				),
				outcome(expected.snapshot),
				sample.name,
			);
			passed++;
		} catch (error) {
			failures.push(sample.name);
			if (process.env.MAILRUN_AUTO_REPLY_TRACE) console.error(error);
		}
	}
	if (failures.length)
		throw new Error(
			JSON.stringify({ passed, failed: failures.length, cases: failures }),
		);
	// The final source case is provider failure; a new incoming message can retry.
	deepStrictEqual(
		state.db.query("SELECT count(*) AS n FROM auto_reply_deliveries").get(),
		{ n: 0 },
	);
	provider.reset();
	const recovery = await intake(autoReplySamples[0]!, "<recovery@example.net>");
	deepStrictEqual(recovery.status, 200);
	await recovery.body?.cancel();
	deepStrictEqual(provider.deliveries.length, 1);
	deepStrictEqual(
		state.db.query("SELECT count(*) AS n FROM auto_reply_deliveries").get(),
		{ n: 1 },
	);
	await stop();
	await prepareAutoReply(state.db, state.directory, autoReplySamples[0]!);
	state.db.query("UPDATE mailrun_installation SET relay_secret=?").run(secret);
	state.db.exec("UPDATE users SET spam_protection_enabled=0");
	provider.reset();
	const waiting = await queueAutoReply(autoReplyInput(autoReplySamples[0]!));
	if (!waiting) throw new Error("Missing automatic-reply job");
	await cron();
	deepStrictEqual(provider.deliveries.length, 1);
	deepStrictEqual(
		state.db.query("SELECT count(*) AS n FROM auto_reply_deliveries").get(),
		{ n: 1 },
	);
	await start();
	const throttled = await intake(
		autoReplySamples[0]!,
		"<after-restart@example.net>",
	);
	deepStrictEqual(throttled.status, 200);
	await throttled.body?.cancel();
	deepStrictEqual(provider.deliveries.length, 1);
	console.log(
		JSON.stringify({
			originalAutomaticReplyIngress: passed,
			providerRecovery: true,
			cronDelivery: true,
			restartThrottle: true,
		}),
	);
} finally {
	await stop();
	provider.stop();
	await state.close();
}
