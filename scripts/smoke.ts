import { resolve } from "node:path";
import { fixture } from "../tests/fixtures";
import { seconds } from "../src/server/db";
import { hash } from "../src/server/auth/service";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { signRelay } from "../src/shared/relay-signature";

const state = await fixture();
const token = crypto.randomUUID();
const password = crypto.randomUUID();
state.db
	.query("UPDATE users SET password_hash=? WHERE id='owner'")
	.run(await bcrypt.hash(password, 4));
state.db
	.query(
		"INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES ('smoke','owner',?,?,?)",
	)
	.run(await hash(token), seconds() + 300, seconds());
const binary = resolve(process.argv[2] ?? "dist/mailrun-local");
const publicBase = "https://mailrun-smoke.example";
const child = Bun.spawn([binary], {
	cwd: state.directory,
	env: {
		...process.env,
		DATA_DIR: state.directory,
		PORT: "0",
		HOST: "127.0.0.1",
		APP_URL: publicBase,
		NODE_ENV: "production",
	},
	stdout: "pipe",
	stderr: "pipe",
});
try {
	const reader = child.stdout.getReader();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const first = await Promise.race([
		reader.read(),
		new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error("Server did not boot within 10 seconds")),
				10_000,
			);
		}),
	]);
	clearTimeout(timer);
	const log = new TextDecoder().decode(first.value);
	const base = log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
	if (!base) throw new Error(`Unexpected startup output: ${log}`);
	reader.releaseLock();
	const csrf = await fetch(`${base}/api/auth/login`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: "https://untrusted.example",
		},
		body: JSON.stringify({ email: "owner@example.com", password }),
	});
	if (csrf.status !== 403)
		throw new Error(`Cross-origin login returned ${csrf.status}`);
	const login = await fetch(`${base}/api/auth/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: publicBase },
		body: JSON.stringify({ email: "owner@example.com", password }),
	});
	const cookie = login.headers
		.getSetCookie()
		.find((value) => value.startsWith("ep_session="));
	if (!login.ok || !cookie?.toLowerCase().includes("httponly"))
		throw new Error(`HTTP login failed: ${login.status}`);
	const sessionCookie = cookie.split(";")[0] ?? "";
	const mailResponse = await fetch(
		`${base}/api/messages?mailboxId=mailbox&status=received`,
		{ headers: { Cookie: sessionCookie } },
	);
	const mail = await mailResponse.json();
	if (
		!mailResponse.ok ||
		!z
			.object({
				messages: z.array(
					z.object({ id: z.string(), subject: z.string().nullable() }),
				),
			})
			.parse(mail)
			.messages.some((message) => message.subject === "A searchable subject")
	)
		throw new Error("Source-compatible message list failed");
	const draftInput = {
		mailboxId: "mailbox",
		to: "maya@example.net",
		subject: "Smoke draft",
		html: "<p>Draft</p>",
		text: "Draft",
	};
	const saved = await fetch(`${base}/api/drafts`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(draftInput),
	});
	const savedDraft = z
		.object({ draft: z.object({ id: z.string() }) })
		.parse(await saved.json()).draft;
	if (!saved.ok || !saved.headers.get("etag"))
		throw new Error("Draft creation or revision headers failed");
	const updated = await fetch(`${base}/api/drafts/${savedDraft.id}`, {
		method: "PATCH",
		headers: {
			Cookie: sessionCookie,
			Origin: publicBase,
			"Content-Type": "application/json",
			"If-Match": saved.headers.get("etag") ?? "",
		},
		body: JSON.stringify({ ...draftInput, subject: "Updated smoke draft" }),
	});
	if (!updated.ok) throw new Error(`Draft update failed: ${updated.status}`);
	const stale = await fetch(`${base}/api/drafts/${savedDraft.id}`, {
		method: "PATCH",
		headers: {
			Cookie: sessionCookie,
			Origin: publicBase,
			"Content-Type": "application/json",
			"If-Match": saved.headers.get("etag") ?? "",
		},
		body: JSON.stringify(draftInput),
	});
	if (stale.status !== 409)
		throw new Error(`Stale draft returned ${stale.status}`);
	const files = new FormData();
	files.append(
		"attachments",
		new File(["%PDF-1.4\n%%EOF"], "smoke.pdf", { type: "application/pdf" }),
	);
	const uploaded = await fetch(
		`${base}/api/drafts/${savedDraft.id}/attachments`,
		{
			method: "POST",
			headers: {
				Cookie: sessionCookie,
				Origin: publicBase,
				"If-Match": updated.headers.get("etag") ?? "",
			},
			body: files,
		},
	);
	const attachment = z
		.object({ attachments: z.array(z.object({ id: z.string() })) })
		.parse(await uploaded.json()).attachments[0];
	if (!uploaded.ok || !attachment) throw new Error("Draft attachment failed");
	const preview = await fetch(
		`${base}/api/messages/${savedDraft.id}/attachments/${attachment.id}?preview=1`,
		{ headers: { Cookie: sessionCookie } },
	);
	if (
		!preview.ok ||
		!preview.headers.get("content-disposition")?.startsWith("inline") ||
		preview.headers.get("x-frame-options") !== "SAMEORIGIN"
	)
		throw new Error("Protected attachment preview failed");
	const foreignPreview = await fetch(
		`${base}/api/messages/${savedDraft.id}/attachments/${attachment.id}?preview=1`,
		{ headers: { Cookie: `ep_session=invalid` } },
	);
	if (foreignPreview.status !== 401)
		throw new Error("Attachment authorization failed");
	// Exercise the compiled Bun websocket and the Start handler in the same process.
	state.db.exec(
		"INSERT INTO mailrun_installation VALUES ('primary','account','zone','example.com','relay','https://mailrun-smoke.example','synthetic-token','synthetic-secret','v1','ready',1)",
	);
	// DOM globals hide Bun's documented headers overload in this shared TS project.
	const NativeWebSocket = WebSocket as typeof WebSocket & {
		new (url: string, options: Bun.WebSocketOptions): WebSocket;
	};
	const socket = new NativeWebSocket(
		base.replace("http:", "ws:") + "/api/realtime",
		{ headers: { Cookie: sessionCookie, Origin: publicBase } },
	);
	const frames: string[] = [];
	socket.addEventListener("message", (event) =>
		frames.push(String(event.data)),
	);
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("WebSocket did not connect")),
			5000,
		);
		socket.addEventListener(
			"open",
			() => {
				clearTimeout(timeout);
				resolve();
			},
			{ once: true },
		);
		socket.addEventListener(
			"error",
			() => {
				clearTimeout(timeout);
				reject(new Error("WebSocket connection failed"));
			},
			{ once: true },
		);
	});
	const nextFrame = (type: string) =>
		new Promise<unknown>((resolve, reject) => {
			const timeout = setTimeout(() => {
				socket.removeEventListener("message", receive);
				reject(new Error("Missing websocket " + type));
			}, 5000);
			const receive = (event: MessageEvent) => {
				const data: unknown = JSON.parse(String(event.data));
				const parsed = z.object({ type: z.string() }).passthrough().parse(data);
				if (parsed.type === type) {
					clearTimeout(timeout);
					socket.removeEventListener("message", receive);
					resolve(parsed);
				}
			};
			socket.addEventListener("message", receive);
		});
	const revision = nextFrame("revision");
	socket.send(JSON.stringify({ type: "ping", revision: null }));
	await revision;
	const newMail = nextFrame("new_message");
	const raw = new TextEncoder().encode(
		"From: sender@example.org\r\nTo: hello@example.com\r\nSubject: Live notification\r\nMessage-ID: <smoke-live@example.org>\r\n\r\nSynthetic realtime test",
	);
	const timestamp = String(Date.now());
	const delivered = await fetch(`${base}/api/inbound`, {
		method: "POST",
		headers: {
			"x-mailrun-from": "sender@example.org",
			"x-mailrun-to": "hello@example.com",
			"x-mailrun-timestamp": timestamp,
			"x-mailrun-signature": await signRelay(
				"synthetic-secret",
				timestamp,
				"sender@example.org",
				"hello@example.com",
				raw,
			),
			"x-mailrun-relay": "2",
		},
		body: raw,
	});
	if (!delivered.ok) throw new Error("Signed relay delivery failed");
	await newMail;
	socket.close();

	const health = await fetch(`${base}/api/health`);
	if (!health.ok)
		throw new Error(`Health failed: ${health.status} ${await health.text()}`);
	const anonymous = await fetch(`${base}/inbox`, { redirect: "manual" });
	if (anonymous.status !== 307 && anonymous.status !== 302)
		throw new Error(`Anonymous inbox was not redirected: ${anonymous.status}`);
	const authenticated = await fetch(`${base}/inbox`, {
		headers: { Cookie: `ep_session=${token}` },
	});
	const html = await authenticated.text();
	if (!authenticated.ok || !html.includes("Mailflare"))
		throw new Error(
			`Inbox SSR failed: ${authenticated.status} ${html.slice(0, 1000)}`,
		);
	if (authenticated.headers.get("cache-control") !== "private, no-store")
		throw new Error("Private inbox is cacheable");
	const asset = html.match(/(?:src|href)="(\/assets\/[^"]+\.js)"/)?.[1];
	if (!asset) throw new Error("No client asset in rendered page");
	const response = await fetch(base + asset);
	if (!response.ok) throw new Error("Embedded asset missing");
	if (!response.headers.get("content-type")?.includes("javascript"))
		throw new Error("Embedded JavaScript has the wrong content type");
	const etag = response.headers.get("etag");
	const conditional = await fetch(base + asset, {
		headers: { "If-None-Match": etag ?? "" },
	});
	if (conditional.status !== 304)
		throw new Error("Conditional asset request did not return 304");
	const deniedDownload = await fetch(`${base}/api/messages/message/original`);
	if (deniedDownload.status !== 401)
		throw new Error(
			`Unauthenticated download returned ${deniedDownload.status}`,
		);
	const task = Bun.spawn([binary, "jobs", "maintenance"], {
		cwd: state.directory,
		env: { ...process.env, DATA_DIR: state.directory },
		stdout: "pipe",
		stderr: "pipe",
	});
	const taskExit = await task.exited;
	const taskOutput = await new Response(task.stdout).text();
	if (taskExit !== 0 || !taskOutput.includes('"job":"maintenance"'))
		throw new Error(
			`Compiled cron task failed: ${taskOutput} ${await new Response(task.stderr).text()}`,
		);
	const registeredTask = Bun.spawn(
		[
			binary,
			"run",
			"--cron-title=mailrun-maintenance",
			"--cron-period=* * * * *",
		],
		{
			cwd: state.directory,
			env: { ...process.env, DATA_DIR: state.directory },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (
		(await registeredTask.exited) !== 0 ||
		!(await new Response(registeredTask.stdout).text()).includes(
			'"job":"maintenance"',
		)
	)
		throw new Error("Bun cron argument dispatch failed");
	const rssProcess = Bun.spawn(["ps", "-o", "rss=", "-p", String(child.pid)], {
		stdout: "pipe",
	});
	const rssKiB = Number((await new Response(rssProcess.stdout).text()).trim());
	console.log(
		JSON.stringify(
			{
				binary,
				health: "passed",
				csrfProtection: "passed",
				originalRestLogin: "passed",
				originalMessageApi: "passed",
				conditionalDraftWrites: "passed",
				attachmentPreviews: "passed",
				liveEmailNotifications: "passed",
				unauthenticatedRedirect: "passed",
				authenticatedInboxSsr: "passed",
				embeddedAssets: "passed",
				conditionalAssets: "passed",
				standaloneCwd: "passed",
				taskCommand: "passed",
				bunCronDispatch: "passed",
				downloadAuthorization: "passed",
				rssMiB: Math.round(rssKiB / 1024),
			},
			null,
			2,
		),
	);
} finally {
	child.kill();
	await child.exited;
	const error = await new Response(child.stderr).text();
	if (error.trim()) console.error(error);
	await state.close();
}
