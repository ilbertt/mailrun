import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { deepStrictEqual } from "node:assert";
import { z } from "zod";
import { fixture } from "../tests/fixtures";
import { hash } from "../src/server/auth/service";
import {
	sendSamples,
	prepareSendFixture,
	sendRequest,
	sendSnapshot,
	sendFields,
} from "../tests/send-contract-fixture";
import capture from "../tests/source-send-contracts.json";
import { startSendProvider } from "../tests/send-provider";
const state = await fixture(),
	binary = resolve(process.argv[2] ?? "dist/mailrun-local"),
	origin = "https://send-fixture.example",
	provider = await startSendProvider(state.directory);
state.db.exec("PRAGMA busy_timeout=5000");
const tokens = { owner: crypto.randomUUID(), stranger: crypto.randomUUID() };
for (const [actor, token] of Object.entries(tokens))
	state.db
		.query(
			"INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,1)",
		)
		.run(
			"send-" + actor,
			actor,
			await hash(token),
			Math.floor(Date.now() / 1000) + 1800,
		);
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
async function cron() {
	const command = Bun.spawn([binary, "jobs", "scheduled"], {
		cwd: state.directory,
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([
		new Response(command.stdout).text(),
		new Response(command.stderr).text(),
	]);
	if (await command.exited) throw new Error("Scheduled fixture failed: " + err);
	return out;
}
try {
	await start();
	if (!existsSync(provider.marker))
		throw new Error("Send network isolation did not load");
	let passed = 0;
	const failures: string[] = [];
	for (const sample of sendSamples) {
		const expected = capture.cases.find((x) => x.name === sample.name);
		if (!expected) throw new Error("Missing source case");
		await prepareSendFixture(state.db, state.directory, sample);
		provider.reset(sample.variant === "provider-failure");
		const request = sendRequest(sample, base, {
			Authorization: "Bearer " + tokens[sample.actor ?? "owner"],
		});
		request.headers.set("Origin", origin);
		const started = Math.floor(Date.now() / 1000),
			response = await fetch(request, { signal: AbortSignal.timeout(30000) });
		try {
			deepStrictEqual(
				await sendSnapshot(
					state.db,
					state.directory,
					response,
					started,
					provider.deliveries,
				),
				expected.snapshot,
				sample.name,
			);
			passed++;
		} catch (error) {
			failures.push(sample.name);
			if (process.env.MAILRUN_SEND_TRACE) console.error(error);
		}
	}
	if (failures.length)
		throw new Error(
			JSON.stringify({ passed, failed: failures.length, cases: failures }),
		);
	await prepareSendFixture(state.db, state.directory, {
		name: "journey",
		kind: "send",
	});
	provider.reset();
	const scheduled = await fetch(base + "/api/send", {
		method: "POST",
		headers: {
			Authorization: "Bearer " + tokens.owner,
			Origin: origin,
			"Content-Type": "application/json",
			"If-Match": '"0"',
		},
		body: JSON.stringify({
			...sendFields,
			draftId: "draft",
			scheduledAt: "2099-01-01T00:00:00Z",
		}),
	});
	deepStrictEqual(scheduled.status, 200);
	const queued = z
		.object({ messageId: z.string(), scheduled: z.literal(true) })
		.parse(await scheduled.json());
	deepStrictEqual(provider.deliveries.length, 0);
	const discarded = await fetch(base + "/api/drafts/draft", {
		method: "DELETE",
		headers: {
			Authorization: "Bearer " + tokens.owner,
			Origin: origin,
			"If-Match": scheduled.headers.get("ETag") ?? "",
		},
	});
	deepStrictEqual(discarded.status, 200);
	await discarded.body?.cancel();
	deepStrictEqual(
		state.db.query("SELECT id FROM messages WHERE id='draft'").get(),
		null,
	);
	await stop();
	state.db
		.query("UPDATE outbound_jobs SET scheduled_at=0 WHERE message_id=?")
		.run(queued.messageId);
	await cron();
	deepStrictEqual(provider.deliveries.length, 1);
	deepStrictEqual(
		state.db
			.query("SELECT status FROM messages WHERE id=?")
			.get(queued.messageId),
		{ status: "sent" },
	);
	await start();
	const cancelled = await fetch(
		base + "/api/messages/scheduled/cancel-schedule",
		{
			method: "POST",
			headers: { Authorization: "Bearer " + tokens.owner, Origin: origin },
		},
	);
	deepStrictEqual(cancelled.status, 200);
	deepStrictEqual(await cancelled.json(), { ok: true });
	await stop();
	provider.reset();
	await cron();
	deepStrictEqual(provider.deliveries.length, 0);
	deepStrictEqual(
		state.db.query("SELECT status FROM messages WHERE id='scheduled'").get(),
		{ status: "draft" },
	);
	console.log(
		JSON.stringify(
			{
				binary,
				originalSendAndCancelContracts: passed,
				sourceRowsPayloadsAndWire: "passed",
				draftCleanupThenRestartedCron: "passed",
				cancelThenRestartedCron: "passed",
				externalEmail: 0,
			},
			null,
			2,
		),
	);
} finally {
	await stop();
	await provider.stop();
	await state.close();
}
