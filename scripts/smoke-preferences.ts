import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { deepStrictEqual } from "node:assert";
import { fixture } from "../tests/fixtures";
import { hash } from "../src/server/auth/service";
import {
	preferenceSamples as samples,
	preparePreferences as prepare,
	preferenceRequest as requestFor,
	preferenceSnapshot as snapshot,
} from "../tests/preferences-fixture";
import capture from "../tests/source-preferences-contracts.json";
import { startSendProvider } from "../tests/send-provider";
const state = await fixture(),
	binary = resolve(process.argv[2] ?? "dist/mailrun-local"),
	origin = "https://preferences-fixture.example",
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
try {
	await start();
	if (!existsSync(provider.marker))
		throw new Error("Contact network isolation did not load");
	let passed = 0;
	const failures: string[] = [];
	for (const sample of samples) {
		const expected = capture.cases.find((x) => x.name === sample.name);
		if (!expected) throw new Error("Missing original case");
		await prepare(state.db, state.directory, sample);
		const request = requestFor(sample, base, {
			Authorization: "Bearer " + tokens[sample.actor ?? "owner"],
		});
		request.headers.set("Origin", origin);
		const started = Math.floor(Date.now() / 1000),
			response = await fetch(request, { signal: AbortSignal.timeout(30000) });
		try {
			deepStrictEqual(
				await snapshot(state.db, response, started),
				expected.snapshot,
				sample.name,
			);
			passed++;
		} catch (error) {
			failures.push(sample.name);
			if (process.env.MAILRUN_CONTACT_TRACE) console.error(error);
		}
	}
	if (failures.length)
		throw new Error(
			JSON.stringify({ passed, failed: failures.length, cases: failures }),
		);
	await prepare(state.db, state.directory, {
		name: "restart",
		path: "/api/settings/profile",
		method: "PATCH",
	});
	for (const [path, fields] of [
		[
			"/api/settings/profile",
			{ name: "Restart profile", resetEmail: "recovery@example.net" },
		],
		["/api/settings/time-zone", { timeZone: "Europe/Rome" }],
	] as const) {
		const request = requestFor(
			{ name: "restart", path, method: "PATCH", fields },
			base,
			{ Authorization: "Bearer " + tokens.owner },
		);
		request.headers.set("Origin", origin);
		const response = await fetch(request);
		deepStrictEqual(response.status, 200);
		await response.body?.cancel();
	}
	const saved = {
		users: state.db
			.query("SELECT name,time_zone,reset_email FROM users ORDER BY id")
			.all(),
		boxes: state.db.query("SELECT * FROM mailboxes ORDER BY id").all(),
		contacts: state.db.query("SELECT * FROM contacts ORDER BY id").all(),
		events: state.db.query("SELECT * FROM calendar_events ORDER BY id").all(),
	};
	await stop();
	await start();
	deepStrictEqual(
		{
			users: state.db
				.query("SELECT name,time_zone,reset_email FROM users ORDER BY id")
				.all(),
			boxes: state.db.query("SELECT * FROM mailboxes ORDER BY id").all(),
			contacts: state.db.query("SELECT * FROM contacts ORDER BY id").all(),
			events: state.db.query("SELECT * FROM calendar_events ORDER BY id").all(),
		},
		saved,
	);
	const restored = await fetch(
		base + "/api/contacts?mailboxId=mailbox&address=hello%40example.com",
		{ headers: { Authorization: "Bearer " + tokens.owner } },
	);
	deepStrictEqual(restored.status, 200);
	const body = await restored.json();
	deepStrictEqual(body.contact.displayName, "Restart profile");
	deepStrictEqual(provider.deliveries.length, 0);
	console.log(
		JSON.stringify({
			originalPreferencesAndMailboxSettings: passed,
			restart: true,
			externalDelivery: 0,
		}),
	);
} finally {
	await stop();
	provider.stop();
	await state.close();
}
