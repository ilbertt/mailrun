import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { deepStrictEqual } from "node:assert";
import { z } from "zod";
import { fixture } from "../tests/fixtures";
import {
	v1SendSamples,
	prepareV1Send,
	v1SendRequest,
	v1SendSnapshot,
	V1_SEND_FIELDS,
} from "../tests/v1-send-fixture";
import capture from "../tests/source-v1-send-contracts.json";
import { startSendProvider } from "../tests/send-provider";
const state = await fixture(),
	binary = resolve(process.argv[2] ?? "dist/mailrun-local"),
	origin = "https://v1-send-fixture.example",
	provider = await startSendProvider(state.directory);
state.db.exec("PRAGMA busy_timeout=5000");
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
		env: {
			...environment,
			MAILRUN_FIXTURE_CLOCK: String(Date.parse("2099-01-01T00:00:01Z")),
		},
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
// node:http allows a deliberately oversized declared length without allocating it.
async function send(request: Request) {
	if (!request.headers.has("Content-Length"))
		return fetch(request, { signal: AbortSignal.timeout(30000) });
	const body = await request.bytes();
	return new Promise<Response>((resolve, reject) => {
		const outbound = httpRequest(
			request.url,
			// Each deliberately incomplete request needs its own connection.
			{
				method: request.method,
				headers: Object.fromEntries(request.headers),
				agent: false,
			},
			(incoming) => {
				const chunks: Buffer[] = [];
				incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
				incoming.on("end", () =>
					resolve(
						new Response(Buffer.concat(chunks), {
							status: incoming.statusCode,
							headers: { "Content-Type": "application/json" },
						}),
					),
				);
				incoming.on("error", reject);
			},
		);
		outbound.setTimeout(10000, () =>
			outbound.destroy(new Error("Public send header check timed out")),
		);
		outbound.on("error", reject);
		outbound.end(body);
	});
}
try {
	await start();
	if (!existsSync(provider.marker))
		throw new Error("Public send network isolation did not load");
	let passed = 0;
	const failures: string[] = [];
	for (const sample of v1SendSamples) {
		if (process.env.MAILRUN_V1_SEND_TRACE) console.error("case", sample.name);
		const expected = capture.cases.find((row) => row.name === sample.name);
		if (!expected) throw new Error("Missing original public send case");
		await prepareV1Send(state.db, state.directory, sample);
		provider.reset(sample.failure);
		const started = Math.floor(Date.now() / 1000),
			response = await send(v1SendRequest(sample, base));
		try {
			deepStrictEqual(
				await v1SendSnapshot(
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
			if (process.env.MAILRUN_V1_SEND_TRACE) console.error(error);
		}
	}
	if (failures.length)
		throw new Error(
			JSON.stringify({ passed, failed: failures.length, cases: failures }),
		);
	const sample = {
		name: "restarted-api-schedule",
		fields: {
			...V1_SEND_FIELDS,
			scheduledAt: "2099-01-01T00:00:00Z",
			attachments: [
				{
					filename: " ../scheduled.txt ",
					type: "TEXT/PLAIN",
					contentBase64: btoa("Scheduled public attachment"),
				},
			],
		},
	};
	await prepareV1Send(state.db, state.directory, sample);
	provider.reset();
	const response = await send(v1SendRequest(sample, base));
	deepStrictEqual(response.status, 200);
	const queued = z
		.object({ messageId: z.string(), scheduled: z.literal(true) })
		.parse(await response.json());
	deepStrictEqual(provider.deliveries.length, 0);
	const before = state.db
		.query("SELECT payload FROM outbound_jobs WHERE message_id=?")
		.get(queued.messageId);
	await stop();
	state.db.exec("DELETE FROM api_keys");
	await cron();
	deepStrictEqual(provider.deliveries.length, 1);
	deepStrictEqual(
		state.db
			.query("SELECT status FROM messages WHERE id=?")
			.get(queued.messageId),
		{ status: "sent" },
	);
	deepStrictEqual(
		state.db
			.query("SELECT payload FROM outbound_jobs WHERE message_id=?")
			.get(queued.messageId),
		before,
	);
	const wire = z
		.object({
			attachments: z.array(
				z.object({
					filename: z.string(),
					type: z.string(),
					content: z.string(),
				}),
			),
		})
		.parse(provider.deliveries[0]);
	deepStrictEqual(wire.attachments, [
		{
			filename: ".._scheduled.txt",
			type: "TEXT/PLAIN",
			content: btoa("Scheduled public attachment"),
		},
	]);
	await cron();
	deepStrictEqual(provider.deliveries.length, 1);
	await start();
	const unauthorized = await send(
		v1SendRequest({ name: "revoked", fields: V1_SEND_FIELDS }, base),
	);
	deepStrictEqual(unauthorized.status, 401);
	await unauthorized.body?.cancel();
	console.log(
		JSON.stringify({
			originalPublicSend: passed,
			scheduledAttachmentAcrossRestart: true,
			revokedKeyDoesNotInvalidatePublishedJob: true,
			restartReplay: true,
			externalDelivery: 0,
		}),
	);
} finally {
	await stop();
	await provider.stop();
	await state.close();
}
