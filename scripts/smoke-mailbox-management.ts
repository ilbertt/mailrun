import { z } from "zod";
import { resolveRouting } from "../src/server/mail/routing";
import { signRelay } from "../src/shared/relay-signature";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { deepStrictEqual } from "node:assert";
import { fixture } from "../tests/fixtures";
import { hash } from "../src/server/auth/service";
import {
	mailboxManagementSamples as samples,
	prepareMailboxManagement as prepare,
	mailboxManagementRequest as requestFor,
	mailboxManagementSnapshot as snapshot,
	mailboxResolutionAddresses,
} from "../tests/mailbox-management-fixture";
import capture from "../tests/source-mailbox-management-contracts.json";
import { startSendProvider } from "../tests/send-provider";
const state = await fixture(),
	binary = resolve(process.argv[2] ?? "dist/mailrun-local"),
	origin = "https://mailboxes-fixture.example",
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
				await snapshot(
					state.db,
					state.directory,
					response,
					started,
					await Promise.all(
						mailboxResolutionAddresses.map(async (address) => ({
							address,
							mailboxId:
								(await resolveRouting(address, "", false))?.mailbox?.id ?? null,
						})),
					),
				),
				expected.snapshot,
				sample.name,
			);
			passed++;
		} catch (error) {
			failures.push(sample.name);
			if (process.env.MAILRUN_MAILBOX_TRACE) console.error(error);
		}
	}
	if (failures.length)
		throw new Error(
			JSON.stringify({ passed, failed: failures.length, cases: failures }),
		);
	await prepare(state.db, state.directory, {
		name: "journey",
		path: "/api/mailboxes",
		method: "GET",
	});
	const secret = crypto.randomUUID();
	state.db.query("UPDATE mailrun_installation SET relay_secret=?").run(secret);
	state.db.exec("UPDATE users SET spam_protection_enabled=0");
	const childToken = crypto.randomUUID();
	state.db
		.query(
			"INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES('child-session','child',?,?,1)",
		)
		.run(await hash(childToken), Math.floor(Date.now() / 1000) + 600);
	async function api(
		path: string,
		method: "GET" | "POST" | "DELETE" | "PATCH" = "GET",
		fields?: unknown,
		token = tokens.owner,
	) {
		return fetch(base + path, {
			method,
			headers: {
				Authorization: "Bearer " + token,
				Origin: origin,
				"Content-Type": "application/json",
			},
			body: fields === undefined ? undefined : JSON.stringify(fields),
		});
	}
	const created = await api("/api/mailboxes", "POST", {
		domainId: "domain",
		localPart: "review",
		displayName: "Review",
		type: "shared",
	});
	deepStrictEqual(created.status, 200);
	const box = z
		.object({ id: z.string(), address: z.string() })
		.parse(await created.json());
	const grant = await api("/api/mailboxes/" + box.id + "/access", "POST", {
		userId: "child",
		permission: "read_only",
	});
	deepStrictEqual(grant.status, 200);
	await grant.body?.cancel();
	const from = "sender@example.net",
		timestamp = String(Date.now()),
		raw = new TextEncoder().encode(
			"From: sender@example.net\r\nTo: " +
				box.address +
				"\r\nSubject: Shared inbox message\r\nMessage-ID: <mailbox-journey@example.net>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nShared body",
		);
	const received = await fetch(base + "/api/inbound", {
		method: "POST",
		headers: {
			"X-Mailrun-From": from,
			"X-Mailrun-To": box.address,
			"X-Mailrun-Relay": "2",
			"X-Mailrun-Timestamp": timestamp,
			"X-Mailrun-Signature": await signRelay(
				secret,
				timestamp,
				from,
				box.address,
				raw,
			),
		},
		body: raw,
	});
	deepStrictEqual(received.status, 200);
	const message = z
		.object({ action: z.literal("store"), messageId: z.string() })
		.parse(await received.json());
	const threadPath = "/api/messages/" + message.messageId + "/thread";
	async function readShared() {
		const response = await api(threadPath, "GET", undefined, childToken);
		deepStrictEqual(response.status, 200);
		const data = z
			.object({
				messages: z.array(z.object({ textBody: z.string().nullable() })),
			})
			.parse(await response.json());
		deepStrictEqual(
			data.messages.some((row) => row.textBody?.includes("Shared body")),
			true,
		);
	}
	await readShared();
	const denied = await api(
		"/api/mailboxes/" + box.id,
		"PATCH",
		{ signature: "Not allowed" },
		childToken,
	);
	deepStrictEqual(denied.status, 404);
	await denied.body?.cancel();
	await stop();
	await start();
	await readShared();
	const revoked = await api(
		"/api/mailboxes/" + box.id + "/access?userId=child",
		"DELETE",
	);
	deepStrictEqual(revoked.status, 200);
	await revoked.body?.cancel();
	const hidden = await api(threadPath, "GET", undefined, childToken);
	deepStrictEqual(hidden.status, 404);
	await hidden.body?.cancel();
	const stored = z
		.object({ raw_r2_key: z.string() })
		.parse(
			state.db
				.query("SELECT raw_r2_key FROM messages WHERE id=?")
				.get(message.messageId),
		);
	const deleted = await api("/api/mailboxes/" + box.id, "DELETE");
	deepStrictEqual(deleted.status, 200);
	await deleted.body?.cancel();
	deepStrictEqual(
		state.db
			.query("SELECT mailbox_id FROM messages WHERE id=?")
			.get(message.messageId),
		{ mailbox_id: null },
	);
	deepStrictEqual(
		await Bun.file(join(state.directory, "blobs", stored.raw_r2_key)).exists(),
		true,
	);
	await stop();
	await start();
	deepStrictEqual(
		state.db.query("SELECT id FROM mailboxes WHERE id=?").get(box.id),
		null,
	);
	deepStrictEqual(
		state.db
			.query("SELECT mailbox_id FROM messages WHERE id=?")
			.get(message.messageId),
		{ mailbox_id: null },
	);
	deepStrictEqual(
		await Bun.file(join(state.directory, "blobs", stored.raw_r2_key)).exists(),
		true,
	);
	deepStrictEqual(provider.deliveries.length, 0);
	console.log(
		JSON.stringify({
			originalMailboxManagement: passed,
			resolverTargets: passed * mailboxResolutionAddresses.length,
			createShareReceiveReadRevokeDelete: true,
			restart: true,
			retainedMime: true,
			externalDelivery: 0,
		}),
	);
} finally {
	await stop();
	provider.stop();
	await state.close();
}
