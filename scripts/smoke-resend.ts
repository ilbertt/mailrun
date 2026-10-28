import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";
import { createHmac } from "node:crypto";
import { fixture } from "../tests/fixtures";
import { hash } from "../src/server/auth/service";
import { seconds } from "../src/server/db";
import {
	startFixtureResendProvider,
	writeResendFixturePreload,
} from "../tests/resend-provider";
const state = await fixture(),
	provider = await startFixtureResendProvider(state.directory),
	preload = await writeResendFixturePreload(state.directory, provider.url),
	token = crypto.randomUUID(),
	binary = resolve(process.argv[2] ?? "dist/mailrun-local"),
	origin = "https://mailrun-resend-smoke.example";
state.db
	.query(
		"INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES('resend-smoke','owner',?,?,?)",
	)
	.run(await hash(token), seconds() + 600, seconds());
state.db.exec(
	"UPDATE domains SET zone_id='manual',sending_provider='resend',receiving_provider='resend'; UPDATE users SET spam_protection_enabled=0",
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
try {
	const reader = child.stdout.getReader();
	let startup = "";
	for (;;) {
		const next = await reader.read();
		if (next.done) break;
		startup += new TextDecoder().decode(next.value);
		if (startup.includes("Mailrun listening")) break;
	}
	reader.releaseLock();
	const base = startup.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
	if (!base || !existsSync(preload.marker))
		throw new Error("Compiled fixture did not start with isolated networking");
	const headers = {
		Cookie: "ep_session=" + token,
		Origin: origin,
		"Content-Type": "application/json",
	};
	async function api(path: string, method = "GET", body?: unknown) {
		const response = await fetch(base + path, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const data: unknown = await response.json();
		if (!response.ok)
			throw new Error(
				`${method} ${path} (${response.status}): ${JSON.stringify(data)}`,
			);
		return data;
	}
	const missing = z
		.object({ keyConfigured: z.boolean() })
		.parse(await api("/api/domains/domain/resend"));
	if (missing.keyConfigured) throw new Error("Expected an unconfigured key");
	const credentials = await api("/api/admin/resend-key", "PUT", {
		apiKey: "re_synthetic-fixture",
	});
	if (JSON.stringify(credentials).includes("re_synthetic-fixture"))
		throw new Error("Credential response leaked the key");
	const domain = z
		.object({
			resend: z.object({ registered: z.boolean(), dnsManaged: z.boolean() }),
		})
		.parse(
			await api("/api/domains/domain/resend", "POST", { action: "setup" }),
		);
	if (!domain.resend.registered || domain.resend.dnsManaged)
		throw new Error("Manual Resend setup failed");
	await api("/api/domains/domain/receiving/resend", "POST", {});
	await api("/api/domains/domain/receiving/resend", "POST", {});
	if (provider.provider.hooks.size !== 1)
		throw new Error("Duplicate shared webhook registration");
	await api("/api/domains/domain/resend", "POST", { action: "test" });
	const created = z.object({ draft: z.object({ id: z.string() }) }).parse(
		await api("/api/drafts", "POST", {
			mailboxId: "mailbox",
			to: "recipient@example.net",
			subject: "Compiled Resend attachment",
			text: "Direct attachment",
		}),
	);
	const content = new Uint8Array(24_000_003);
	crypto.getRandomValues(content.subarray(0, 64));
	content[content.length - 1] = 255;
	const form = new FormData();
	form.append(
		"attachments",
		new File([content], "large.bin", { type: "application/octet-stream" }),
	);
	const uploaded = await fetch(
		base + "/api/drafts/" + created.draft.id + "/attachments",
		{
			method: "POST",
			headers: { Cookie: headers.Cookie, Origin: origin },
			body: form,
		},
	);
	const fileData = z
		.object({ attachments: z.array(z.object({ id: z.string() })) })
		.parse(await uploaded.json());
	if (!uploaded.ok || fileData.attachments.length !== 1)
		throw new Error("Compiled attachment upload failed");
	async function sendForm(
		draftId: string,
		subject: string,
		to: string,
		text: string,
		revision: number,
		scheduledAt?: string,
	) {
		const form = new FormData();
		for (const [key, value] of Object.entries({
			draftId,
			mailboxId: "mailbox",
			to,
			subject,
			text,
			html: "",
			...(scheduledAt ? { scheduledAt } : {}),
		}))
			form.append(key, value);
		const result = await fetch(base + "/api/send", {
			method: "POST",
			headers: {
				Cookie: headers.Cookie,
				Origin: origin,
				"If-Match": `"${revision}"`,
			},
			body: form,
		});
		if (!result.ok)
			throw new Error("Compiled send failed: " + (await result.text()));
		await result.body?.cancel();
	}
	let peak = 0;
	const measure = () => {
		const result = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(child.pid)]);
		const value = Number(result.stdout.toString().trim());
		if (Number.isFinite(value)) peak = Math.max(peak, Math.round(value / 1024));
	};
	measure();
	const sample = setInterval(measure, 25);
	try {
		await sendForm(
			created.draft.id,
			"Compiled Resend attachment",
			"recipient@example.net",
			"Direct attachment",
			Number(uploaded.headers.get("ETag")?.replaceAll('"', "")),
		);
	} finally {
		clearInterval(sample);
		measure();
	}
	const sent = z
		.object({ attachments: z.array(z.object({ content: z.string() })) })
		.parse(
			provider.provider.calls.find(
				(row) =>
					row.method === "POST" &&
					row.url.endsWith("/emails") &&
					z.object({ subject: z.string() }).safeParse(row.body).data
						?.subject === "Compiled Resend attachment",
			)?.body,
		);
	const actual = Buffer.from(sent.attachments[0]?.content ?? "", "base64");
	if (!actual.equals(Buffer.from(content)))
		throw new Error("Streamed Resend attachment differs");
	if (state.db.query("SELECT id FROM shared_attachment_links").all().length)
		throw new Error("Resend file was replaced with a link");
	const event = JSON.stringify({
			type: "email.received",
			data: { email_id: "received" },
		}),
		timestamp = String(seconds()),
		id = "compiled-resend-event",
		signature = createHmac("sha256", Buffer.from("synthetic-webhook-secret"))
			.update(`${id}.${timestamp}.${event}`)
			.digest("base64");
	const inboundHeaders = {
		"svix-id": id,
		"svix-timestamp": timestamp,
		"svix-signature": "v1," + signature,
	};
	for (let attempt = 0; attempt < 2; attempt++) {
		const response = await fetch(base + "/api/inbound/resend", {
			method: "POST",
			headers: inboundHeaders,
			body: event,
		});
		if (
			!response.ok ||
			z.object({ delivered: z.number() }).parse(await response.json())
				.delivered !== 1
		)
			throw new Error("Compiled signed intake failed");
	}
	if (
		state.db
			.query("SELECT id FROM messages WHERE subject='Resend received'")
			.all().length !== 1
	)
		throw new Error("Provider replay duplicated the message");
	const scheduled = z
		.object({ draft: z.object({ id: z.string(), revision: z.number() }) })
		.parse(
			await api("/api/drafts", "POST", {
				mailboxId: "mailbox",
				to: "later@example.net",
				subject: "Resend cron recovery",
				text: "Persisted schedule",
				scheduledAt: new Date(Date.now() + 120_000).toISOString(),
			}),
		);
	await sendForm(
		scheduled.draft.id,
		"Resend cron recovery",
		"later@example.net",
		"Persisted schedule",
		scheduled.draft.revision,
		new Date(Date.now() + 120_000).toISOString(),
	);
	for (const route of ["/domains", "/mailboxes", "/settings/account"]) {
		const page = await fetch(base + route, {
			headers: { Cookie: headers.Cookie },
		});
		if (!page.ok) throw new Error("Resend fixture route failed " + route);
		await page.body?.cancel();
	}
	child.kill("SIGTERM");
	await child.exited;
	stopped = true;
	state.db.exec(
		"UPDATE outbound_jobs SET scheduled_at=0 WHERE status='queued'",
	);
	const job = Bun.spawn([binary, "jobs", "scheduled"], {
		cwd: state.directory,
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [log, jobErrors, exit] = await Promise.all([
		new Response(job.stdout).text(),
		new Response(job.stderr).text(),
		job.exited,
	]);
	if (exit !== 0 || !log.includes('"skipped":false'))
		throw new Error("Compiled Resend cron failed " + jobErrors);
	if (
		!provider.provider.calls.some(
			(row) =>
				row.url.endsWith("/emails") &&
				z.object({ subject: z.string() }).safeParse(row.body).data?.subject ===
					"Resend cron recovery",
		)
	)
		throw new Error("Scheduled mail was not sent through the fixture");
	if (
		z
			.object({ status: z.literal("sent") })
			.safeParse(
				state.db
					.query("SELECT status FROM messages WHERE id=?")
					.get(scheduled.draft.id),
			).success !== true
	)
		throw new Error("Cron delivery did not commit its sent state");
	console.log(
		JSON.stringify(
			{
				credentialMasking: "passed",
				manualProviderSetup: "passed",
				sharedWebhook: "passed",
				systemTest: "passed",
				streamedAttachmentBytes: content.length,
				signedIntake: "passed",
				duplicateDelivery: "passed",
				cronRecovery: "passed",
				nativeSendRssObservedMiB: peak,
				externalRequests: 0,
			},
			null,
			2,
		),
	);
} finally {
	if (!stopped) {
		child.kill("SIGTERM");
		await child.exited;
	}
	await provider.stop();
	await state.close();
	const stderr = await errors;
	if (stderr.trim()) console.error(stderr);
}
