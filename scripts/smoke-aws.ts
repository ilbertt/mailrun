import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { z } from "zod";
import { fixture } from "../tests/fixtures";
import { fixtureAwsConfig } from "../tests/aws-fixture";
import {
	startFixtureAwsProvider,
	writeAwsFixturePreload,
} from "../tests/aws-provider";
import { hash } from "../src/server/auth/service";
import { seconds } from "../src/server/db";
const state = await fixture(),
	provider = await startFixtureAwsProvider(state.directory),
	preload = await writeAwsFixturePreload(state.directory, provider.url),
	token = crypto.randomUUID(),
	origin = "https://mailrun-aws-smoke.example",
	binary = resolve(process.argv[2] ?? "dist/mailrun-local");
state.db
	.query(
		"INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES('aws-smoke','owner',?,?,?)",
	)
	.run(await hash(token), seconds() + 600, seconds());
state.db.exec(
	"UPDATE domains SET zone_id='manual',sending_provider='ses',receiving_provider='ses'; UPDATE users SET spam_protection_enabled=0",
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
		throw new Error(
			"Compiled AWS fixture did not start with isolated networking",
		);
	provider.setApplicationBase(base);
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
			}),
			data: unknown = await response.json();
		if (!response.ok)
			throw new Error(
				`${method} ${path} (${response.status}): ${JSON.stringify(data)}`,
			);
		return data;
	}
	if (
		z
			.object({ status: z.object({ configured: z.boolean() }) })
			.parse(await api("/api/admin/aws")).status.configured
	)
		throw new Error("Expected absent credentials");
	const configured = await api("/api/admin/aws", "PUT", fixtureAwsConfig);
	if (
		JSON.stringify(configured).includes(fixtureAwsConfig.secretAccessKey) ||
		JSON.stringify(configured).includes(fixtureAwsConfig.accessKeyId)
	)
		throw new Error("Credentials leaked");
	const view = z
		.object({
			ses: z.object({
				registered: z.boolean(),
				verified: z.boolean(),
				dnsManaged: z.boolean(),
			}),
		})
		.parse(await api("/api/domains/domain/ses", "POST", { action: "setup" }));
	if (!view.ses.registered || !view.ses.verified || view.ses.dnsManaged)
		throw new Error("Manual identity setup failed");
	await api("/api/domains/domain/receiving/ses", "POST", {});
	await api("/api/domains/domain/receiving/ses", "POST", {});
	if (
		provider.provider.calls.filter((row) => row.action === "Subscribe")
			.length !== 1
	)
		throw new Error("Repeated setup duplicated SNS subscription");
	const saved = z
		.object({ bucket: z.string(), topicArn: z.string(), token: z.string() })
		.parse(
			JSON.parse(
				z
					.object({ ses_receiving: z.string() })
					.parse(
						state.db
							.query(
								"SELECT ses_receiving FROM app_settings WHERE id='default'",
							)
							.get(),
					).ses_receiving,
			),
		);
	if (
		!(provider.provider.topics.get(saved.topicArn) ?? []).some(
			(row) => row.confirmed,
		)
	)
		throw new Error("Early SNS confirmation was not accepted");
	await api("/api/domains/domain/ses", "POST", { action: "test" });
	const created = z
		.object({ draft: z.object({ id: z.string() }) })
		.parse(
			await api("/api/drafts", "POST", {
				mailboxId: "mailbox",
				to: "recipient@example.net",
				subject: "Compiled SES attachment",
				text: "Direct SES attachment",
			}),
		);
	const content = new Uint8Array(24_000_003);
	crypto.getRandomValues(content.subarray(0, 64));
	content[content.length - 1] = 255;
	const upload = new FormData();
	upload.append(
		"attachments",
		new File([content], "large.bin", { type: "application/octet-stream" }),
	);
	const uploaded = await fetch(
		base + "/api/drafts/" + created.draft.id + "/attachments",
		{
			method: "POST",
			headers: { Cookie: headers.Cookie, Origin: origin },
			body: upload,
		},
	);
	if (!uploaded.ok)
		throw new Error("Attachment upload failed: " + (await uploaded.text()));
	await uploaded.body?.cancel();
	async function sendForm(
		id: string,
		subject: string,
		revision: number,
		scheduledAt?: string,
	) {
		const form = new FormData();
		for (const [key, value] of Object.entries({
			draftId: id,
			mailboxId: "mailbox",
			to: "recipient@example.net",
			subject,
			text: "Direct SES attachment",
			html: "",
			...(scheduledAt ? { scheduledAt } : {}),
		}))
			form.append(key, value);
		const response = await fetch(base + "/api/send", {
			method: "POST",
			headers: {
				Cookie: headers.Cookie,
				Origin: origin,
				"If-Match": `"${revision}"`,
			},
			body: form,
		});
		if (!response.ok)
			throw new Error(
				`SES send (${response.status}): ` + (await response.text()),
			);
		await response.body?.cancel();
	}
	let peak = 0;
	const measure = () => {
		const sampled = Bun.spawnSync([
				"ps",
				"-o",
				"rss=",
				"-p",
				String(child.pid),
			]),
			value = Number(sampled.stdout.toString().trim());
		if (Number.isFinite(value)) peak = Math.max(peak, Math.round(value / 1024));
	};
	measure();
	const sampling = setInterval(measure, 25);
	try {
		await sendForm(
			created.draft.id,
			"Compiled SES attachment",
			Number(uploaded.headers.get("ETag")?.replaceAll('"', "")),
		);
	} finally {
		clearInterval(sampling);
		measure();
	}
	const sent = z
		.object({
			Content: z.object({
				Simple: z.object({
					Subject: z.object({ Data: z.string() }),
					Attachments: z.array(
						z.object({ RawContent: z.string(), FileName: z.string() }),
					),
				}),
			}),
		})
		.parse(
			provider.provider.calls.find(
				(row) =>
					row.path === "/v2/email/outbound-emails" &&
					z
						.object({
							Content: z.object({
								Simple: z.object({ Subject: z.object({ Data: z.string() }) }),
							}),
						})
						.safeParse(row.body).data?.Content.Simple.Subject.Data ===
						"Compiled SES attachment",
			)?.body,
		);
	if (
		!Buffer.from(
			sent.Content.Simple.Attachments[0]!.RawContent,
			"base64",
		).equals(Buffer.from(content))
	)
		throw new Error("Signed attachment content differs");
	if (state.db.query("SELECT id FROM shared_attachment_links").all().length)
		throw new Error("SES attachment replaced with a link");
	const failed = z
		.object({ draft: z.object({ id: z.string(), revision: z.number() }) })
		.parse(
			await api("/api/drafts", "POST", {
				mailboxId: "mailbox",
				to: "recipient@example.net",
				subject: "SES failure",
				text: "Keep this draft",
			}),
		);
	provider.provider.sendStatus = 503;
	try {
		await sendForm(failed.draft.id, "SES failure", failed.draft.revision);
		throw new Error("Provider failure unexpectedly succeeded");
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!error.message.includes("(500):") ||
			!error.message.includes("Synthetic SES send failure")
		)
			throw error;
	} finally {
		provider.provider.sendStatus = 200;
	}
	if (
		!z
			.object({ status: z.literal("draft") })
			.safeParse(
				state.db
					.query("SELECT status FROM messages WHERE id=?")
					.get(failed.draft.id),
			).success
	)
		throw new Error("Failed draft was not restored");
	provider.provider.objects.set(
		saved.bucket + "/inbound/compiled-ses",
		new TextEncoder().encode(
			"From: sender@example.net\r\nTo: hello@example.com\r\nSubject: Compiled SES received\r\nMessage-ID: <compiled-ses@example.net>\r\n\r\nS3 receipt content",
		),
	);
	const event = JSON.stringify({
		Type: "Notification",
		TopicArn: saved.topicArn,
		Message: JSON.stringify({
			notificationType: "Received",
			mail: { source: "sender@example.net" },
			receipt: {
				recipients: ["hello@example.com"],
				virusVerdict: { status: "PASS" },
				action: {
					type: "S3",
					bucketName: saved.bucket,
					objectKey: "inbound/compiled-ses",
				},
			},
		}),
	});
	for (let attempt = 0; attempt < 2; attempt++) {
		const response = await fetch(
			base + "/api/inbound/ses?token=" + saved.token,
			{ method: "POST", body: event },
		);
		if (
			!response.ok ||
			z.object({ delivered: z.number() }).parse(await response.json())
				.delivered !== 1
		)
			throw new Error("Compiled SES intake failed");
	}
	if (
		state.db
			.query("SELECT id FROM messages WHERE subject='Compiled SES received'")
			.all().length !== 1 ||
		state.db.query("SELECT id FROM mailrun_ses_receipts").all().length !== 1
	)
		throw new Error("SNS delivery was not idempotent");
	if (provider.provider.objects.size)
		throw new Error("Temporary object was not consumed");
	const later = z
		.object({ draft: z.object({ id: z.string(), revision: z.number() }) })
		.parse(
			await api("/api/drafts", "POST", {
				mailboxId: "mailbox",
				to: "recipient@example.net",
				subject: "SES cron recovery",
				text: "Body",
			}),
		);
	await sendForm(
		later.draft.id,
		"SES cron recovery",
		later.draft.revision,
		new Date(Date.now() + 120_000).toISOString(),
	);
	for (const route of ["/domains", "/mailboxes", "/settings/account"]) {
		const page = await fetch(base + route, {
			headers: { Cookie: headers.Cookie },
		});
		if (!page.ok) throw new Error("Provider route failed " + route);
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
	const [output, jobErrors, exit] = await Promise.all([
		new Response(job.stdout).text(),
		new Response(job.stderr).text(),
		job.exited,
	]);
	if (exit !== 0 || !output.includes('"skipped":false'))
		throw new Error("SES cron failed " + jobErrors);
	if (
		!z
			.object({ status: z.literal("sent") })
			.safeParse(
				state.db
					.query("SELECT status FROM messages WHERE id=?")
					.get(later.draft.id),
			).success
	)
		throw new Error("Cron did not commit sent state");
	const root = join(state.directory, "sending-staging");
	for (const directory of await readdir(root))
		if ((await readdir(join(root, directory))).length)
			throw new Error("Signed payload staging was not cleaned");
	console.log(
		JSON.stringify(
			{
				credentialMasking: "passed",
				signedCapabilityChecks: "passed",
				identitySetup: "passed",
				earlySubscriptionConfirmation: "passed",
				signedAttachmentBytes: content.length,
				failureRecovery: "passed",
				snsIntake: "passed",
				receiptReplayAfterObjectDeletion: "passed",
				stagingCleanup: "passed",
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
