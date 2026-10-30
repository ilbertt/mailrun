// Browser fixture only. All accounts/data are synthetic; controls bind loopback.
import { Database } from "bun:sqlite";
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { mkdir, copyFile } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { fixture } from "../tests/fixtures";
import { hash } from "../src/server/auth/service";

const { values } = parseArgs({
	options: {
		reference: { type: "string" },
		before: { type: "string" },
		after: { type: "string" },
		port: { type: "string" },
	},
});
const args = z
	.object({
		reference: z.string(),
		before: z.string(),
		after: z.string().default("dist/mailrun-local"),
		port: z.coerce.number().int().min(1024).max(65520).default(4510),
	})
	.parse(values);
const reference = resolve(args.reference),
	node = Bun.which("node");
if (!node || !(await Bun.file(join(reference, ".next-node/BUILD_ID")).exists()))
	throw new Error("Build the original Node/Next production reference first");
const state = await fixture(),
	token = "synthetic-browser-session-" + crypto.randomUUID(),
	digest = await hash(token);
state.db
	.query("UPDATE users SET password_hash=?")
	.run(await bcrypt.hash("session-fixture-password", 4));
state.db.exec(
	"INSERT INTO users(id,email,name,password_hash,role,is_primary_admin,created_at) VALUES('other-admin','other-admin@example.com','Other administrator','test-only','admin',0,1)",
);
state.db.exec(
	"UPDATE users SET email='hello@example.com' WHERE id='owner'; UPDATE domains SET routing_enabled=1; UPDATE messages SET subject='Owner fixture message',text_body='Owner-only fixture body',snippet='Owner-only fixture body' WHERE id='message'; INSERT INTO mailboxes(id,user_id,domain_id,local_part,created_at) VALUES('stranger-mailbox','stranger','domain','stranger',1); INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,snippet,text_body,status,created_at) VALUES('stranger-message','stranger','stranger-mailbox','inbound','sender@example.org','stranger@example.com','Stranger fixture message','Stranger-only fixture body','Stranger-only fixture body','received',1)",
);
state.db
	.query(
		"INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES('fixture-session','owner',?,?,1)",
	)
	.run(digest, Math.floor(Date.now() / 1000) + 7200);
state.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const children: ReturnType<typeof Bun.spawn>[] = [],
	proxies: ReturnType<typeof Bun.serve>[] = [],
	databases: Database[] = [];
let stopping = false;
const releases: (() => void)[] = [];
async function stop() {
	if (stopping) return;
	stopping = true;
	for (const release of releases) release();
	for (const child of children) child.kill("SIGTERM");
	const timer = setTimeout(() => {
		for (const child of children) child.kill("SIGKILL");
	}, 5000);
	try {
		await Promise.all(children.map((child) => child.exited));
		for (const proxy of proxies) await proxy.stop(true);
	} finally {
		clearTimeout(timer);
		for (const db of databases) db.close();
		await state.close();
	}
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
try {
	for (const [index, name] of (
		["original", "before", "after"] as const
	).entries()) {
		const directory = join(state.directory, name),
			port = args.port + index,
			target = args.port + 7 + index;
		await mkdir(directory);
		await copyFile(state.path, join(directory, "mailflare.sqlite"));
		const db = new Database(join(directory, "mailflare.sqlite"));
		databases.push(db);
		let seedDocument = true,
			held = 0,
			hold: ReturnType<typeof Promise.withResolvers<void>> | undefined;
		const requests: Record<string, number> = {};
		proxies.push(
			Bun.serve({
				hostname: "127.0.0.1",
				port,
				async fetch(request) {
					const url = new URL(request.url);
					if (url.pathname === "/_fixture/state")
						return Response.json({
							name,
							held,
							requests,
							user: db
								.query(
									"SELECT role,is_primary_admin,disabled,time_zone FROM users WHERE id='owner'",
								)
								.get(),
						});
					if (
						url.pathname === "/_fixture/action" &&
						request.method === "POST"
					) {
						const { action } = z
							.object({
								action: z.enum([
									"reset",
									"delegated",
									"user",
									"revoke",
									"hold-detail",
									"release",
									"new-york",
								]),
							})
							.parse(await request.json());
						if (action === "reset") {
							db.exec(
								"UPDATE users SET role='admin',is_primary_admin=1,disabled=0,time_zone=NULL WHERE id='owner'; UPDATE users SET is_primary_admin=0 WHERE id='other-admin'; DELETE FROM sessions WHERE user_id='owner'",
							);
							db.query(
								"INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES('fixture-session','owner',?,?,1)",
							).run(digest, Math.floor(Date.now() / 1000) + 7200);
							seedDocument = true;
						} else if (action === "delegated")
							db.exec(
								"UPDATE users SET role='admin',is_primary_admin=0 WHERE id='owner'; UPDATE users SET is_primary_admin=1 WHERE id='other-admin'",
							);
						else if (action === "user")
							db.exec(
								"UPDATE users SET role='user',is_primary_admin=0 WHERE id='owner'; UPDATE users SET is_primary_admin=1 WHERE id='other-admin'",
							);
						else if (action === "revoke")
							db.exec("DELETE FROM sessions WHERE user_id='owner'");
						else if (action === "new-york")
							db.exec(
								"UPDATE users SET time_zone='America/New_York' WHERE id='owner'",
							);
						else if (action === "hold-detail") {
							hold = Promise.withResolvers<void>();
							releases.push(hold.resolve);
							held = 0;
						} else {
							hold?.resolve();
							hold = undefined;
						}
						return Response.json({ action, ok: true });
					}
					requests[url.pathname] = (requests[url.pathname] ?? 0) + 1;
					const headers = new Headers(request.headers),
						initial =
							seedDocument &&
							request.headers.get("accept")?.includes("text/html");
					if (initial) {
						headers.set("Cookie", "ep_session=" + token);
						seedDocument = false;
					}
					headers.set("Host", `127.0.0.1:${target}`);
					headers.delete("Accept-Encoding");
					const response = await fetch(
						`http://127.0.0.1:${target}${url.pathname}${url.search}`,
						{
							method: request.method,
							headers,
							body: request.body,
							redirect: "manual",
						},
					);
					const outgoing = new Headers(response.headers);
					outgoing.delete("Content-Encoding");
					outgoing.delete("Content-Length");
					if (initial)
						outgoing.append(
							"Set-Cookie",
							"ep_session=" + token + "; Path=/; HttpOnly; SameSite=Lax",
						);
					if (
						hold &&
						url.pathname === "/api/messages/message" &&
						request.method === "GET" &&
						response.ok
					) {
						const waiting = hold.promise,
							body = await response.arrayBuffer();
						held++;
						await waiting;
						return new Response(body, {
							status: response.status,
							headers: outgoing,
						});
					}
					return new Response(response.body, {
						status: response.status,
						headers: outgoing,
					});
				},
			}),
		);
		const binary =
			name === "before" ? resolve(args.before) : resolve(args.after);
		children.push(
			Bun.spawn(name === "original" ? [node, "dist/server.mjs"] : [binary], {
				cwd: name === "original" ? reference : directory,
				env: {
					PATH: process.env.PATH,
					HOME: process.env.HOME,
					TMPDIR: process.env.TMPDIR,
					NODE_ENV: "production",
					HOST: "127.0.0.1",
					PORT: String(target),
					DATA_DIR: directory,
					APP_URL: `http://127.0.0.1:${port}`,
					MAILFLARE_RUNTIME: "node",
					SMTP_INBOUND_PORT: "0",
				},
				stdout: Bun.file(join(state.directory, name + ".log")),
				stderr: Bun.file(join(state.directory, name + "-error.log")),
			}),
		);
	}
	for (const [index, child] of children.entries()) {
		let ready = false;
		for (let attempt = 0; attempt < 60; attempt++) {
			if (child.exitCode !== null)
				throw new Error("Fixture child exited during startup");
			try {
				const response = await fetch(
					`http://127.0.0.1:${args.port + 7 + index}/api/auth/me`,
					{
						headers: { Cookie: "ep_session=" + token },
						signal: AbortSignal.timeout(500),
					},
				);
				if (
					response.ok &&
					z
						.object({ user: z.object({ id: z.literal("owner") }) })
						.safeParse(await response.json()).success
				) {
					ready = true;
					break;
				}
			} catch {}
			await Bun.sleep(250);
		}
		if (!ready) throw new Error("Fixture did not become ready");
	}
	console.log(
		JSON.stringify({
			urls: ["original", "before", "after"].map((name, index) => ({
				name,
				url: `http://127.0.0.1:${args.port + index}/inbox`,
			})),
			directory: state.directory,
		}),
	);
	await new Promise<void>((resolve) => {
		const timer = setInterval(() => {
			if (stopping) {
				clearInterval(timer);
				resolve();
			}
		}, 100);
	});
} catch (error) {
	await stop();
	throw error;
}
