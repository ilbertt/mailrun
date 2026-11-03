import { test, expect, beforeEach, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { fixture, owner, stranger } from "./fixtures";
import { cloudflareFixture } from "./cloudflare-fixture";
import { resendFixture } from "./resend-fixture";
import { ResendClient } from "../src/server/resend/client";
import { resendKeyApi } from "../src/server/api/resend-key";
import { resendDomainApi } from "../src/server/api/resend-domain";
import { domainsApi } from "../src/server/api/domains";
import {
	resendKeyStatus,
	saveResendKey,
	resendWebhookSecret,
	storeResendWebhook,
} from "../src/server/resend/settings";
import {
	getResendReceiving,
	setupResendReceiving,
	setupResendSending,
} from "../src/server/resend/domains";
import { getDomain } from "../src/server/domains/service";
import {
	resendInbound,
	intakeProviderMail,
} from "../src/server/resend/inbound";
import {
	saveDraft,
	getDraft,
	uploadAttachments,
} from "../src/server/mail/drafts";
import { sendDraft, deliverJob } from "../src/server/mail/send";
import { sendThroughProvider } from "../src/server/mail/provider";
import { sendSystemMail } from "../src/server/mail/system";
import { LocalStorage } from "../src/server/storage";
import { seconds } from "../src/server/db";
import { publicOrigin } from "../src/server/config";
import { writeBackup, restoreBackup } from "../src/lib/backups/export";
let state: Awaited<ReturnType<typeof fixture>>,
	resend: ReturnType<typeof resendFixture>,
	dns: ReturnType<typeof cloudflareFixture>;
let environment: string | undefined, appUrl: string | undefined;
beforeEach(async () => {
	state = await fixture();
	resend = resendFixture();
	dns = cloudflareFixture();
	environment = process.env.RESEND_API_KEY;
	delete process.env.RESEND_API_KEY;
	appUrl = process.env.APP_URL;
	process.env.APP_URL = "https://mail.example.com";
});
afterEach(async () => {
	if (environment === undefined) delete process.env.RESEND_API_KEY;
	else process.env.RESEND_API_KEY = environment;
	if (appUrl === undefined) delete process.env.APP_URL;
	else process.env.APP_URL = appUrl;
	await state.close();
});
const key = "re_synthetic-fixture";
const request = (
	path: string,
	method = "GET",
	body?: unknown,
	origin = publicOrigin(),
) =>
	new Request(publicOrigin() + path, {
		method,
		headers: { Origin: origin, "Content-Type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
const client = () => new ResendClient(key, resend.send);
async function configure() {
	await saveResendKey(owner, key);
	state.db.exec(
		"UPDATE domains SET sending_provider='resend',receiving_provider='resend'",
	);
}
function signed(event: unknown) {
	const body = typeof event === "string" ? event : JSON.stringify(event),
		id = "event-fixture",
		timestamp = String(seconds()),
		secret = Buffer.from("synthetic-webhook-secret");
	return new Request(publicOrigin() + "/api/inbound/resend", {
		method: "POST",
		headers: {
			"svix-id": id,
			"svix-timestamp": timestamp,
			"svix-signature":
				"v1," +
				createHmac("sha256", secret)
					.update(`${id}.${timestamp}.${body}`)
					.digest("base64"),
		},
		body,
	});
}
async function prepareWebhook() {
	await configure();
	await storeResendWebhook(
		key,
		"hook",
		"whsec_" + Buffer.from("synthetic-webhook-secret").toString("base64"),
		async () => {},
	);
}

test("key management masks credentials, accepts send-only keys, preserves environment fallback and rejects invalid/unreachable keys", async () => {
	process.env.RESEND_API_KEY = "re_environment-fixture";
	expect(
		await (await resendKeyApi(
			request("/api/admin/resend-key"),
			owner,
			resend.send,
		))!.json(),
	).toEqual({ configured: true, source: "environment" });
	resend.mode = "restricted";
	const saved = await resendKeyApi(
		request("/api/admin/resend-key", "PUT", { apiKey: " " + key + " " }),
		owner,
		resend.send,
	);
	expect(await saved!.json()).toEqual({
		configured: true,
		source: "settings",
		canManageDomains: false,
	});
	expect((await resendKeyStatus()).apiKey).toBe(key);
	resend.mode = "invalid";
	expect(
		(await resendKeyApi(
			request("/api/admin/resend-key", "PUT", { apiKey: "bad" }),
			owner,
			resend.send,
		))!.status,
	).toBe(400);
	resend.mode = "unreachable";
	expect(
		(await resendKeyApi(
			request("/api/admin/resend-key", "PUT", { apiKey: "bad" }),
			owner,
			resend.send,
		))!.status,
	).toBe(502);
	expect((await resendKeyStatus()).apiKey).toBe(key);
	const deleted = await resendKeyApi(
		request("/api/admin/resend-key", "DELETE"),
		owner,
		resend.send,
	);
	expect(await deleted!.json()).toEqual({
		configured: true,
		source: "environment",
	});
});
test("credential mutations enforce origin and recheck primary role after the network check", async () => {
	await expect(
		resendKeyApi(request("/api/admin/resend-key"), stranger, resend.send),
	).rejects.toMatchObject({ status: 403 });
	expect(
		(await resendKeyApi(
			request(
				"/api/admin/resend-key",
				"PUT",
				{ apiKey: key },
				"https://foreign.example",
			),
			owner,
			resend.send,
		))!.status,
	).toBe(403);
	expect(resend.calls).toHaveLength(0);
	resend.onRequest = () => {
		state.db.exec("UPDATE users SET is_primary_admin=0 WHERE id='owner'");
	};
	await expect(
		resendKeyApi(
			request("/api/admin/resend-key", "PUT", { apiKey: key }),
			owner,
			resend.send,
		),
	).rejects.toMatchObject({ status: 403 });
	expect((await resendKeyStatus()).configured).toBe(false);
});
test("sending setup publishes only its missing records and leaves incoming MX untouched", async () => {
	await configure();
	const remote = resend.addDomain("example.com", false, true);
	dns.addRecord({
		type: "MX",
		name: "example.com",
		content: "route1.mx.cloudflare.net",
		priority: 10,
	});
	const domain = await getDomain(owner, "domain");
	const result = await setupResendSending(domain, client(), dns.client);
	expect(result).toMatchObject({
		registered: true,
		status: "verified",
		missingDns: 0,
		dnsManaged: true,
	});
	expect(result.records).toHaveLength(3);
	expect(
		dns.records
			.filter((row) => row.name === "example.com" && row.type === "MX")
			.map((row) => row.content),
	).toEqual(["route1.mx.cloudflare.net"]);
	expect(resend.domains.get(remote.id)?.capabilities).toEqual({
		sending: "enabled",
		receiving: "enabled",
	});
	const count = dns.records.length;
	await setupResendSending(domain, client(), dns.client);
	expect(dns.records).toHaveLength(count);
});
test("manual DNS and restricted provider keys retain source response contracts", async () => {
	await configure();
	state.db.exec("UPDATE domains SET zone_id='manual'");
	resend.addDomain();
	const response = await resendDomainApi(
		request("/api/domains/domain/resend", "POST", { action: "setup" }),
		owner,
		undefined,
		resend.send,
	);
	expect(await response!.json()).toMatchObject({
		resend: { dnsManaged: false, missingDns: null, registered: true },
	});
	resend.mode = "restricted";
	expect(
		await (await resendDomainApi(
			request("/api/domains/domain/resend"),
			owner,
			undefined,
			resend.send,
		))!.json(),
	).toEqual({ keyConfigured: true, canManageDomains: false, resend: null });
	expect(
		await getResendReceiving(
			await getDomain(owner, "domain"),
			publicOrigin(),
			client(),
		),
	).toMatchObject({ restrictedKey: true, ready: false, dnsManaged: false });
});
test("receiving asks for MX confirmation, shares one signed webhook and reports the actual readiness checklist", async () => {
	await configure();
	resend.addDomain();
	dns.addRecord({
		type: "MX",
		name: "example.com",
		content: "previous.example.net",
		priority: 10,
	});
	const path = "/api/domains/domain/receiving/resend";
	const conflict = await resendDomainApi(
		request(path, "POST", {}),
		owner,
		dns.client,
		resend.send,
	);
	expect(conflict!.status).toBe(409);
	expect(await conflict!.json()).toMatchObject({ code: "MX_CONFLICT" });
	expect(dns.records.map((row) => row.content)).toEqual([
		"previous.example.net",
	]);
	expect(resend.hooks.size).toBe(0);
	expect(
		(await resendDomainApi(
			request(path, "POST", { replaceMx: true }),
			owner,
			dns.client,
			resend.send,
		))!.status,
	).toBe(200);
	expect(
		await getResendReceiving(
			await getDomain(owner, "domain"),
			publicOrigin(),
			client(),
			dns.client,
		),
	).toMatchObject({ ready: true, mx: "inbound-smtp.us-east-1.amazonaws.com" });
	await resendDomainApi(
		request(path, "POST", {}),
		owner,
		dns.client,
		resend.send,
	);
	expect(resend.hooks.size).toBe(1);
	expect(
		resend.calls.filter(
			(row) => row.method === "POST" && row.url.endsWith("/webhooks"),
		),
	).toHaveLength(1);
	expect((await resendWebhookSecret())?.resend_webhook_secret).toStartWith(
		"whsec_",
	);
});
test("an existing webhook without the matching saved secret is replaced, and local-only origins cause no provisioning", async () => {
	await configure();
	resend.addDomain();
	resend.hooks.set("unknown", {
		id: "unknown",
		endpoint: publicOrigin() + "/api/inbound/resend",
		events: ["email.received"],
	});
	const domain = await getDomain(owner, "domain");
	await expect(
		setupResendReceiving(
			domain,
			client(),
			"http://localhost:3000",
			true,
			dns.client,
		),
	).rejects.toThrow("public HTTPS");
	expect(resend.calls).toHaveLength(0);
	await setupResendReceiving(
		domain,
		client(),
		publicOrigin(),
		false,
		dns.client,
	);
	expect(resend.hooks.has("unknown")).toBe(false);
	expect(resend.hooks.size).toBe(1);
	expect((await resendWebhookSecret())?.resend_webhook_id).toBe(
		[...resend.hooks.keys()][0],
	);
});
test("removing unused sending preserves receiving, its MX and the shared webhook", async () => {
	await configure();
	resend.addDomain("example.com", true, true);
	const domain = await getDomain(owner, "domain");
	await setupResendSending(domain, client(), dns.client);
	await setupResendReceiving(
		domain,
		client(),
		publicOrigin(),
		false,
		dns.client,
	);
	const blocked = await resendDomainApi(
		request("/api/domains/domain/sending", "DELETE", { target: "resend" }),
		owner,
		dns.client,
		resend.send,
	);
	expect(blocked!.status).toBe(400);
	state.db.exec("UPDATE domains SET sending_provider='none'");
	const result = await resendDomainApi(
		request("/api/domains/domain/sending", "DELETE", { target: "resend" }),
		owner,
		dns.client,
		resend.send,
	);
	expect(result!.status).toBe(200);
	expect([...resend.domains.values()][0]?.capabilities).toEqual({
		sending: "disabled",
		receiving: "enabled",
	});
	expect(dns.records.map((row) => row.content)).toEqual([
		"inbound-smtp.us-east-1.amazonaws.com",
	]);
	expect(resend.hooks.size).toBe(1);
});
test("domain access and provider presence use live ownership without exposing credentials", async () => {
	await configure();
	resend.addDomain("example.com", true, true);
	expect(
		(await domainsApi(
			request("/api/domains/domain/sending"),
			owner,
			dns.client,
			undefined,
			resend.send,
		))!.status,
	).toBe(200);
	const status = await (await domainsApi(
		request("/api/domains/domain/sending"),
		owner,
		dns.client,
		undefined,
		resend.send,
	))!.json();
	expect(status).toMatchObject({ resend: true, resendStatus: "pending" });
	expect(JSON.stringify(status)).not.toContain(key);
	await expect(
		resendDomainApi(
			request("/api/domains/domain/resend"),
			stranger,
			dns.client,
			resend.send,
		),
	).rejects.toMatchObject({ status: 404 });
	state.db.exec("UPDATE users SET is_primary_admin=0 WHERE id='owner'");
	await expect(
		resendDomainApi(
			request("/api/domains/domain/resend", "POST", { action: "setup" }),
			owner,
			dns.client,
			resend.send,
		),
	).rejects.toMatchObject({ status: 403 });
});
test("immediate and scheduled Resend sends need no Cloudflare installation; large files stay attachments with inline CID", async () => {
	await configure();
	const draft = await saveDraft(owner, {
		mailboxId: "mailbox",
		to: "recipient@example.net",
		cc: "copy@example.net",
		bcc: "hidden@example.net",
		subject: "A reply",
		text: "Reply body",
		html: "<p>Reply body</p>",
		inReplyTo: "<parent@example.net>",
		references: "<root@example.net> <parent@example.net>",
	});
	const content = new Uint8Array(4_000_003);
	crypto.getRandomValues(content.subarray(0, 64));
	content[content.length - 1] = 255;
	const files = await uploadAttachments(owner, draft.id, [
		new File([content], "large.bin", { type: "application/octet-stream" }),
	]);
	state.db.exec(
		"UPDATE message_attachments SET disposition='inline',content_id='image-fixture' WHERE message_id='" +
			draft.id +
			"'",
	);
	await sendDraft(owner, draft.id, files.draft_revision, resend.send);
	const sent = z
		.object({
			from: z.string(),
			to: z.array(z.string()),
			cc: z.array(z.string()),
			bcc: z.array(z.string()),
			headers: z.record(z.string(), z.string()),
			attachments: z.array(
				z.object({
					filename: z.string(),
					content: z.string(),
					content_id: z.string(),
				}),
			),
		})
		.parse(resend.calls.find((row) => row.url.endsWith("/emails"))?.body);
	expect(sent.to).toEqual(["recipient@example.net"]);
	expect(sent.cc).toEqual(["copy@example.net"]);
	expect(sent.bcc).toEqual(["hidden@example.net"]);
	expect(sent.headers["In-Reply-To"]).toBe("<parent@example.net>");
	expect(sent.attachments[0]?.content_id).toBe("image-fixture");
	expect(Buffer.from(sent.attachments[0]!.content, "base64")).toEqual(
		Buffer.from(content),
	);
	expect(
		state.db.query("SELECT id FROM shared_attachment_links").all(),
	).toHaveLength(0);
	expect(
		state.db
			.query("SELECT status,provider_message_id FROM messages WHERE id=?")
			.get(draft.id),
	).toEqual({
		status: "sent",
		provider_message_id: sent.headers["Message-ID"]!,
	});
	const scheduled = await saveDraft(owner, {
		mailboxId: "mailbox",
		to: "later@example.net",
		subject: "Later",
		cc: "",
		bcc: "",
		html: "",
		text: "Scheduled body",
		scheduledAt: new Date(Date.now() + 60_000).toISOString(),
	});
	await sendDraft(owner, scheduled.id, scheduled.draft_revision, resend.send);
	const job = z
		.object({ id: z.string() })
		.parse(
			state.db
				.query("SELECT id FROM outbound_jobs WHERE message_id=?")
				.get(scheduled.id),
		);
	state.db.exec(
		"UPDATE outbound_jobs SET scheduled_at=0 WHERE status='queued'",
	);
	await deliverJob(job.id, resend.send);
	expect(
		resend.calls.filter((row) => row.url.endsWith("/emails")),
	).toHaveLength(2);
});
test("provider failure restores an editable draft, while deterministic message IDs accompany stable idempotency keys", async () => {
	await configure();
	resend.sendStatus = 503;
	const draft = await saveDraft(owner, {
		mailboxId: "mailbox",
		to: "recipient@example.net",
		subject: "Failure",
		cc: "",
		bcc: "",
		html: "",
		text: "Keep this draft",
	});
	await expect(
		sendDraft(owner, draft.id, draft.draft_revision, resend.send),
	).rejects.toThrow("Synthetic send failure");
	expect((await getDraft(owner, draft.id)).status).toBe("draft");
	resend.sendStatus = 200;
	const message = {
		from: "hello@example.com",
		to: ["recipient@example.net"],
		subject: "Idempotent",
		text: "Body",
	};
	const first = await sendThroughProvider(
		{ provider: "resend", apiKey: key },
		message,
		resend.send,
		"same-job",
	);
	const second = await sendThroughProvider(
		{ provider: "resend", apiKey: key },
		message,
		resend.send,
		"same-job",
	);
	expect(first).toEqual(second);
	expect(
		resend.calls.slice(-2).map((row) => row.headers.get("Idempotency-Key")),
	).toEqual(["same-job", "same-job"]);
});
test("system tests use the selected sender without Sent copies, contacts or outbound webhooks", async () => {
	await configure();
	expect(
		await sendSystemMail(
			{
				to: "owner@example.com",
				subject: "System test",
				text: "Synthetic",
				html: "",
				hostname: "example.com",
			},
			resend.send,
		),
	).toBe(true);
	expect(state.db.query("SELECT id FROM messages").all()).toHaveLength(1);
	expect(state.db.query("SELECT id FROM outbound_jobs").all()).toHaveLength(0);
	expect(
		state.db.query("SELECT id FROM webhook_deliveries").all(),
	).toHaveLength(0);
});
test("signed Resend intake verifies raw bytes before fetch, stores local MIME once and never sends credentials to the raw host", async () => {
	await prepareWebhook();
	const unsigned = new Request(publicOrigin() + "/api/inbound/resend", {
		method: "POST",
		body: JSON.stringify({
			type: "email.received",
			data: { email_id: "received" },
		}),
	});
	expect((await resendInbound(unsigned, resend.send)).status).toBe(401);
	expect(resend.calls).toHaveLength(0);
	const event = { type: "email.received", data: { email_id: "received" } };
	expect(
		await (await resendInbound(signed(event), resend.send)).json(),
	).toEqual({ delivered: 1, dropped: null });
	expect(
		await (await resendInbound(signed(event), resend.send)).json(),
	).toEqual({ delivered: 1, dropped: null });
	const rows = z
		.array(z.object({ raw_r2_key: z.string() }))
		.parse(
			state.db
				.query(
					"SELECT raw_r2_key FROM messages WHERE subject='Resend received'",
				)
				.all(),
		);
	expect(rows).toHaveLength(1);
	expect(await new LocalStorage().file(rows[0]!.raw_r2_key).text()).toBe(
		new TextDecoder().decode(resend.raw),
	);
});
test("intake handles ignored/malformed/missing events, stale signatures, bounded raw downloads and redacted failures", async () => {
	await prepareWebhook();
	expect(
		await (
			await resendInbound(signed({ type: "email.sent" }), resend.send)
		).json(),
	).toEqual({ ignored: true });
	expect((await resendInbound(signed("not json"), resend.send)).status).toBe(
		400,
	);
	expect(
		(await resendInbound(signed({ type: "email.received" }), resend.send))
			.status,
	).toBe(400);
	const stale = signed({ type: "email.received", data: { id: "received" } });
	stale.headers.set("svix-timestamp", "1");
	expect((await resendInbound(stale, resend.send)).status).toBe(401);
	resend.rawLength = 26 * 1024 * 1024;
	expect(
		await (
			await resendInbound(
				signed({ type: "email.received", data: { id: "received" } }),
				resend.send,
			)
		).json(),
	).toEqual({
		delivered: 0,
		dropped: "Message exceeds the 25 MiB receiving limit",
	});
	resend.rawLength = undefined;
	resend.rawError = true;
	const failed = await resendInbound(
		signed({ type: "email.received", data: { id: "received" } }),
		resend.send,
	);
	expect(failed.status).toBe(502);
	const text = await failed.text();
	expect(text).not.toContain("private-fixture-signature");
	expect(text).not.toContain(key);
});
test("provider intake normalizes and deduplicates recipients, ignores foreign domains and preserves source accepted-count semantics", async () => {
	await configure();
	const result = await intakeProviderMail({
		from: "Sender <sender@example.net>",
		recipients: [
			"Hello <HELLO@example.com>",
			"hello@example.com",
			"missing@example.com",
			"foreign@foreign.example",
		],
		raw: resend.raw,
	});
	expect(result).toEqual({ delivered: 2, dropped: null });
	expect(
		state.db
			.query("SELECT id FROM messages WHERE subject='Resend received'")
			.all(),
	).toHaveLength(1);
});
test("existing backup groups preserve Resend key and webhook metadata without a new table", async () => {
	await prepareWebhook();
	const path = join(state.directory, "resend-backup.json");
	await writeBackup(state.path, path);
	const backup = await Bun.file(path).json();
	state.db.exec(
		"UPDATE app_settings SET resend_api_key=NULL,resend_webhook_id=NULL,resend_webhook_secret=NULL",
	);
	restoreBackup(state.db, backup);
	expect((await resendKeyStatus()).apiKey).toBe(key);
	expect((await resendWebhookSecret())?.resend_webhook_id).toBe("hook");
});

test("credential rotation during webhook creation cannot publish its obsolete secret", async () => {
	await configure();
	resend.addDomain();
	resend.onRequest = async (request) => {
		if (
			request.method === "POST" &&
			new URL(request.url).pathname === "/webhooks"
		)
			await saveResendKey(owner, "re_rotated-fixture");
	};
	const response = await resendDomainApi(
		request("/api/domains/domain/receiving/resend", "POST", {}),
		owner,
		dns.client,
		resend.send,
	);
	expect(response!.status).toBe(502);
	expect(await response!.json()).toMatchObject({
		error: "Resend credentials changed. Try setup again.",
	});
	expect(resend.hooks.size).toBe(0);
	expect(await resendWebhookSecret()).toMatchObject({
		resend_webhook_id: null,
		resend_webhook_secret: null,
	});
});

test("a failed streaming transport closes the attachment reader without retaining a request timer", async () => {
	let closed = false;
	class TrackedBlob extends Blob {
		override stream() {
			return new ReadableStream<Uint8Array<ArrayBuffer>>({
				pull(controller) {
					controller.enqueue(new Uint8Array([1, 2, 3]));
				},
				cancel() {
					closed = true;
				},
			});
		}
	}
	await expect(
		sendThroughProvider(
			{ provider: "resend", apiKey: key },
			{
				from: "hello@example.com",
				to: ["recipient@example.net"],
				subject: "Canceled",
				text: "Body",
				attachments: [
					{
						filename: "tracked.bin",
						type: "application/octet-stream",
						content: new TrackedBlob(),
						disposition: "attachment",
					},
				],
			},
			async (_input, init) => {
				if (!(init?.body instanceof ReadableStream))
					throw new Error("Expected a streamed provider body");
				const reader = init.body.getReader();
				try {
					for (let count = 0; count < 4; count++) await reader.read();
				} finally {
					reader.releaseLock();
				}
				throw new Error("Synthetic transport disconnect");
			},
			"canceled-job",
		),
	).rejects.toThrow("Synthetic transport disconnect");
	expect(closed).toBe(true);
});

test("provider forwarding accepts no-copy deliveries and stores keep-copy fallback without attempting a second transport", async () => {
	await configure();
	const { saveRule } = await import("../src/server/mail/management");
	await saveRule(owner, {
		domainId: "domain",
		scope: "domain",
		name: "Provider forward",
		enabled: true,
		matchField: "recipient",
		matchOperator: "contains",
		matchValue: "*",
		action: "forward",
		mailboxId: "mailbox",
		keepCopy: false,
		forwardTo: "forward@example.net",
		rejectReason: "",
		priority: 0,
	});
	expect(
		await intakeProviderMail({
			from: "sender@example.net",
			recipients: ["unknown@example.com"],
			raw: resend.raw,
		}),
	).toEqual({ delivered: 1, dropped: null });
	expect(
		state.db
			.query("SELECT id FROM messages WHERE subject='Resend received'")
			.all(),
	).toHaveLength(0);
	state.db.exec("UPDATE routing_rules SET keep_copy=1");
	expect(
		await intakeProviderMail({
			from: "sender@example.net",
			recipients: ["unknown@example.com"],
			raw: resend.raw,
		}),
	).toEqual({ delivered: 1, dropped: null });
	expect(
		state.db
			.query("SELECT id FROM messages WHERE subject='Resend received'")
			.all(),
	).toHaveLength(1);
	expect(resend.calls).toHaveLength(0);
});

test("manual-domain DNS details and summaries render provider controls without Cloudflare credentials", async () => {
	await configure();
	state.db.exec("UPDATE domains SET zone_id='manual'");
	const response = await domainsApi(
		request("/api/domains/domain/dns"),
		owner,
		undefined,
		async () => [],
	);
	expect(response?.status).toBe(200);
	expect(await response!.json()).toMatchObject({
		domain: { zoneId: "manual", sendingEnabled: false },
		dns: {
			routing: { status: "manual" },
			sending: [],
			audit: { mx: { status: "missing" } },
		},
	});
	const list = await domainsApi(
		request("/api/domains?includeDns=true"),
		owner,
		undefined,
		async () => [],
	);
	expect(list?.status).toBe(200);
	expect(await list!.json()).toMatchObject({
		dns: {
			domain: { sending: { configured: false }, auth: { mx: "missing" } },
		},
	});
});

test("delivery API failures retain the source provider message after credential redaction", async () => {
	const { apiErrorResponse } = await import("../src/server/api/errors");
	let failure: unknown;
	try {
		await new ResendClient(key, async () => {
			throw new Error("Synthetic failure with " + key);
		}).request("/emails", z.unknown(), { method: "POST" });
	} catch (error) {
		failure = error;
	}
	const response = await apiErrorResponse(failure);
	expect(response.status).toBe(500);
	expect(await response.json()).toEqual({
		error: "Synthetic failure with [redacted]",
	});
});
