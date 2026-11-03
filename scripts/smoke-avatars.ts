import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";
import { fixture, enableTeamSharing, owner } from "../tests/fixtures";
import {
	startFixtureAvatarProvider,
	writeAvatarFixturePreload,
	fixtureAvatarPng,
} from "../tests/avatar-provider";
import { hash } from "../src/server/auth/service";
import { seconds } from "../src/server/db";
import { upsertContact } from "../src/server/mail/contacts";
const state = await fixture(),
	provider = await startFixtureAvatarProvider(state.directory),
	preload = await writeAvatarFixturePreload(state.directory, provider.url),
	binary = resolve(process.argv[2] ?? "dist/mailrun-local"),
	token = crypto.randomUUID(),
	viewerToken = crypto.randomUUID(),
	origin = "https://mailrun-avatar-smoke.example";
enableTeamSharing(state.db);
state.db.exec(
	"INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES('avatar-share','mailbox','stranger','read_only',1); INSERT INTO mailboxes(id,user_id,domain_id,local_part,created_at) VALUES('private','owner','domain','private',2)",
);
for (const [id, userId, value] of [
	["avatar-owner", "owner", token],
	["avatar-viewer", "stranger", viewerToken],
] as const)
	state.db
		.query(
			"INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)",
		)
		.run(id, userId, await hash(value!), seconds() + 600, seconds());
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
	BUN_OPTIONS: "--preload " + preload.path,
};
const child = Bun.spawn([binary], {
		cwd: state.directory,
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	}),
	errors = new Response(child.stderr).text();
let stopped = false;
const sockets: WebSocket[] = [];
try {
	const reader = child.stdout.getReader();
	let output = "";
	for (;;) {
		const next = await reader.read();
		if (next.done) break;
		output += new TextDecoder().decode(next.value);
		if (output.includes("Mailrun listening")) break;
	}
	reader.releaseLock();
	const base = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
	if (!base || !existsSync(preload.marker))
		throw new Error("Isolated avatar fixture did not start");
	const headers = {
		Cookie: "ep_session=" + token,
		Origin: origin,
		"Content-Type": "application/json",
	};
	const ownerEvents: unknown[] = [],
		viewerEvents: unknown[] = [];
	async function socket(session: string, events: unknown[]) {
		const NativeWebSocket = WebSocket as typeof WebSocket & {
			new (url: string, options: Bun.WebSocketOptions): WebSocket;
		};
		const ws = new NativeWebSocket(
			base!.replace("http:", "ws:") + "/api/realtime",
			{
				headers: { Cookie: "ep_session=" + session, Origin: origin },
			},
		);
		sockets.push(ws);
		ws.addEventListener("message", (event) => {
			if (typeof event.data === "string") events.push(JSON.parse(event.data));
		});
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener(
				"error",
				() => reject(new Error("WebSocket failed")),
				{ once: true },
			);
		});
		return ws;
	}
	await socket(token, ownerEvents);
	await socket(viewerToken, viewerEvents);
	async function block(mailboxId: string, address: string) {
		const response = await fetch(base + "/api/contacts/block", {
			method: "POST",
			headers,
			body: JSON.stringify({ mailboxId, address }),
		});
		if (!response.ok)
			throw new Error("Block contact failed: " + (await response.text()));
		await response.body?.cancel();
	}
	async function waitForAvatar(email: string) {
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			const row = z
				.object({ avatar_key: z.string().nullable() })
				.safeParse(
					state.db
						.query(
							"SELECT avatar_key FROM contacts WHERE user_id=? AND email=?",
						)
						.get(owner.id, email),
				);
			if (row.success && row.data.avatar_key) return row.data.avatar_key;
			await Bun.sleep(10);
		}
		throw new Error("Eager avatar import did not complete");
	}
	await block("mailbox", "sender@example.org");
	await waitForAvatar("sender@example.org");
	const url =
		base +
		"/api/contacts/avatar?mailboxId=mailbox&address=sender%40example.org";
	const full = await fetch(url + "&v=1", { headers });
	if (
		!full.ok ||
		full.headers.get("Content-Type") !== "image/png" ||
		full.headers.get("Cache-Control") !==
			"private, max-age=31536000, immutable" ||
		!Buffer.from(await full.arrayBuffer()).equals(Buffer.from(fixtureAvatarPng))
	)
		throw new Error("Full avatar response differs");
	const preview = await fetch(url + "&variant=preview", { headers });
	if (!preview.ok || preview.headers.get("Content-Type") !== "image/png")
		throw new Error("Avatar preview failed");
	await preview.body?.cancel();
	const cached = await fetch(url, {
		headers: {
			Cookie: headers.Cookie,
			"If-None-Match": full.headers.get("ETag")!,
		},
	});
	if (cached.status !== 304)
		throw new Error("Avatar conditional request failed");
	const shared = await fetch(url, {
		headers: { Cookie: "ep_session=" + viewerToken },
	});
	if (!shared.ok) throw new Error("Shared reader lost avatar access");
	await shared.body?.cancel();
	const deadline = Date.now() + 2000;
	while (
		Date.now() < deadline &&
		!viewerEvents.some(
			(value) =>
				z
					.object({
						type: z.literal("contact_avatar"),
						email: z.literal("sender@example.org"),
					})
					.safeParse(value).success,
		)
	)
		await Bun.sleep(10);
	if (
		!ownerEvents.some(
			(value) =>
				z
					.object({
						type: z.literal("contact_avatar"),
						email: z.literal("sender@example.org"),
					})
					.safeParse(value).success,
		) ||
		!viewerEvents.some(
			(value) =>
				z
					.object({
						type: z.literal("contact_avatar"),
						email: z.literal("sender@example.org"),
					})
					.safeParse(value).success,
		)
	)
		throw new Error("Live avatar event missing");
	await block("private", "private@example.org");
	await waitForAvatar("private@example.org");
	await Bun.sleep(30);
	if (
		viewerEvents.some(
			(value) =>
				z.object({ email: z.literal("private@example.org") }).safeParse(value)
					.success,
		)
	)
		throw new Error("Private contact leaked to shared reader");
	const expectedHash = new Bun.CryptoHasher("sha256")
		.update("sender@example.org")
		.digest("hex");
	if (
		!provider.calls.some((value) =>
			value.includes("/avatar/" + expectedHash + "?d=404&r=g&s=256"),
		)
	)
		throw new Error("Gravatar address hash differs");
	sockets.forEach((ws) => ws.close());
	child.kill("SIGTERM");
	await child.exited;
	stopped = true;
	await upsertContact(owner.id, "cron@example.org", "inbound", "mailbox");
	const job = Bun.spawn([binary, "jobs", "maintenance"], {
		cwd: state.directory,
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [log, error, exit] = await Promise.all([
		new Response(job.stdout).text(),
		new Response(job.stderr).text(),
		job.exited,
	]);
	if (exit !== 0 || !log.includes('"skipped":false'))
		throw new Error("Avatar cron failed " + error);
	const recovered = z
		.object({ avatar_key: z.string().min(1) })
		.safeParse(
			state.db
				.query("SELECT avatar_key FROM contacts WHERE email='cron@example.org'")
				.get(),
		);
	if (!recovered.success)
		throw new Error("Cron did not recover pending avatar");
	console.log(
		JSON.stringify(
			{
				automaticImport: "passed",
				mimeAndCaching: "passed",
				previewAndConditional: "passed",
				sharedAccess: "passed",
				liveRefresh: "passed",
				privateContactIsolation: "passed",
				maintenanceRecovery: "passed",
				providerCalls: provider.calls.length,
			},
			null,
			2,
		),
	);
} finally {
	sockets.forEach((ws) => ws.close());
	if (!stopped) {
		child.kill("SIGTERM");
		await child.exited;
	}
	await provider.stop();
	await state.close();
	const stderr = await errors;
	if (stderr.trim()) console.error(stderr);
}
