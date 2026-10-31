import { test, expect, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { join, resolve, dirname } from "node:path";
import { stat, mkdir, readdir } from "node:fs/promises";
import { fixture, owner, stranger } from "./fixtures";
import { awsFixture, fixtureAwsConfig } from "./aws-fixture";
import { cloudflareFixture } from "./cloudflare-fixture";
import vectors from "./aws-signing-vectors.json";
import { signAwsRequest } from "../src/server/aws/sigv4";
import { AwsClient } from "../src/server/aws/client";
import { awsApi } from "../src/server/api/aws";
import { awsDomainApi } from "../src/server/api/aws-domain";
import {
	getAwsConfig,
	getAwsConfigStatus,
	saveAwsConfig,
	clearAwsConfig,
	getSesReceivingState,
} from "../src/server/aws/settings";
import {
	setupSesSending,
	sesSendingView,
	setupSesReceiving,
	sesReceivingView,
	removeSesSending,
	SES_OBJECT_PREFIX,
} from "../src/server/aws/domains";
import { sesInbound } from "../src/server/aws/inbound";
import { getDomain } from "../src/server/domains/service";
import { domainsApi } from "../src/server/api/domains";
import { sendDraft, deliverJob } from "../src/server/mail/send";
import {
	saveDraft,
	uploadAttachments,
	getDraft,
} from "../src/server/mail/drafts";
import { sendSystemMail } from "../src/server/mail/system";
import {
	stageSendBody,
	clearSendingStaging,
} from "../src/server/mail/sending-staging";
import { getMigrations } from "../src/server/assets";
import { migrate } from "../src/server/db";
import {
	writeBackup,
	restoreBackup,
	coveredTables,
} from "../src/lib/backups/export";
let state: Awaited<ReturnType<typeof fixture>>,
	aws: ReturnType<typeof awsFixture>,
	dns: ReturnType<typeof cloudflareFixture>;
const keys = [
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_SESSION_TOKEN",
	"APP_URL",
] as const;
let environment: Record<string, string | undefined>;
beforeEach(async () => {
	state = await fixture();
	aws = awsFixture();
	dns = cloudflareFixture();
	environment = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
	process.env.APP_URL = "https://mail.example.com";
});
afterEach(async () => {
	for (const key of keys) {
		if (environment[key] === undefined) delete process.env[key];
		else process.env[key] = environment[key];
	}
	await state.close();
});
const request = (
	path: string,
	method = "GET",
	body?: unknown,
	origin = "https://mail.example.com",
) =>
	new Request("https://mail.example.com" + path, {
		method,
		headers: { Origin: origin, "Content-Type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
const client = () => new AwsClient(fixtureAwsConfig, aws.send);
async function configure() {
	await saveAwsConfig(owner, fixtureAwsConfig, aws.accountId);
	state.db.exec(
		"UPDATE domains SET sending_provider='ses',receiving_provider='ses'",
	);
}
function notification(
	key = "inbound/message",
	overrides: Record<string, unknown> = {},
) {
	return {
		notificationType: "Received",
		mail: {
			source: "sender@example.net",
			destination: ["hello@example.com"],
			headers: [],
		},
		receipt: {
			recipients: ["hello@example.com"],
			virusVerdict: { status: "PASS" },
			action: { type: "S3", bucketName: "", objectKey: key },
		},
		...overrides,
	};
}
async function envelope(message: unknown, type = "Notification") {
	const config = await getSesReceivingState();
	if (!config) throw new Error("No receiving state");
	const data =
		typeof message === "object" && message !== null && "receipt" in message
			? message
			: null;
	if (data) {
		if ("receipt" in data) {
			const rec = data.receipt;
			if (
				rec &&
				typeof rec === "object" &&
				"action" in rec &&
				rec.action &&
				typeof rec.action === "object"
			)
				Object.assign(rec.action, { bucketName: config.bucket });
		}
	}
	return request("/api/inbound/ses?token=" + config.token, "POST", {
		Type: type,
		TopicArn: config.topicArn,
		Message: JSON.stringify(message),
	});
}
async function receiving() {
	await configure();
	await setupSesReceiving(
		await getDomain(owner, "domain"),
		client(),
		"https://mail.example.com",
		false,
		dns.client,
	);
	const value = await getSesReceivingState();
	if (!value) throw new Error("Setup did not persist receiving state");
	return value;
}

test("SigV4 matches pinned official AWS vectors for query encoding, UTF-8, form bodies and session tokens", async () => {
	for (const row of vectors.vectors) {
		const context = z
			.object({
				credentials: z.object({
					access_key_id: z.string(),
					secret_access_key: z.string(),
					token: z.string().optional(),
				}),
				timestamp: z.string(),
				region: z.string(),
				service: z.string(),
			})
			.parse(row.context);
		const [head, ...tail] = row.request.split("\n\n"),
			lines = head!.split("\n"),
			first = lines.shift()!,
			match = /^(\w+) (.+) HTTP\//.exec(first);
		if (!match) throw new Error("Malformed official vector");
		const headers: Record<string, string> = {};
		for (const line of lines) {
			if (!line) continue;
			const colon = line.indexOf(":");
			headers[line.slice(0, colon)] = line.slice(colon + 1);
		}
		if (row.context.sign_body)
			headers["x-amz-content-sha256"] = new Bun.CryptoHasher("sha256")
				.update(tail.join("\n\n"))
				.digest("hex");
		const signed = await signAwsRequest({
			method: match[1]!,
			url: new URL(match[2]!, `https://${headers.Host}`),
			headers,
			body: tail.join("\n\n"),
			region: context.region,
			service: context.service,
			credentials: {
				accessKeyId: context.credentials.access_key_id,
				secretAccessKey: context.credentials.secret_access_key,
				sessionToken: context.credentials.token,
			},
			now: new Date(context.timestamp),
		});
		expect({ vector: row.name, authorization: signed.Authorization }).toEqual({
			vector: row.name,
			authorization: row.authorization,
		});
	}
});

test("AWS controls verify credentials, report capabilities and mask saved secrets with environment fallback", async () => {
	process.env.AWS_ACCESS_KEY_ID = fixtureAwsConfig.accessKeyId;
	process.env.AWS_SECRET_ACCESS_KEY = fixtureAwsConfig.secretAccessKey;
	process.env.AWS_DEFAULT_REGION = "us-east-1";
	process.env.AWS_SESSION_TOKEN = "synthetic-session-token";
	expect(await getAwsConfig()).toMatchObject({
		sessionToken: "synthetic-session-token",
	});
	expect(await getAwsConfigStatus()).toMatchObject({
		configured: true,
		source: "environment",
		accessKeyHint: "7890",
		accountId: null,
	});
	const response = await awsApi(
		request("/api/admin/aws", "PUT", fixtureAwsConfig),
		owner,
		aws.send,
	);
	expect(response!.status).toBe(200);
	const body = await response!.json();
	expect(body).toMatchObject({
		status: { source: "settings", accountId: aws.accountId },
		report: {
			sending: true,
			receiving: true,
			sns: true,
			s3: true,
			productionAccess: false,
			missing: [],
		},
	});
	expect(JSON.stringify(body)).not.toContain(fixtureAwsConfig.secretAccessKey);
	expect(JSON.stringify(body)).not.toContain(fixtureAwsConfig.accessKeyId);
	await clearAwsConfig(owner);
	expect((await getAwsConfigStatus()).source).toBe("environment");
});
test("invalid credentials, no SES permissions and malformed regions never overwrite saved AWS settings", async () => {
	await configure();
	aws.invalidCredentials = true;
	const invalid = await awsApi(
		request("/api/admin/aws", "PUT", fixtureAwsConfig),
		owner,
		aws.send,
	);
	expect(invalid!.status).toBe(400);
	expect(await invalid!.json()).toMatchObject({
		error:
			"AWS rejected these credentials. Check the access key ID and secret.",
	});
	aws.invalidCredentials = false;
	aws.denied.add("GetAccount");
	aws.denied.add("DescribeActiveReceiptRuleSet");
	const denied = await awsApi(
		request("/api/admin/aws", "PUT", fixtureAwsConfig),
		owner,
		aws.send,
	);
	expect(denied!.status).toBe(400);
	expect(await denied!.json()).toMatchObject({
		report: { sending: false, receiving: false },
	});
	const count = aws.calls.length;
	expect(
		(await awsApi(
			request("/api/admin/aws", "PUT", {
				...fixtureAwsConfig,
				region: "us-east-1@foreign.example",
			}),
			owner,
			aws.send,
		))!.status,
	).toBe(400);
	expect(aws.calls).toHaveLength(count);
	expect(await getAwsConfig()).toEqual(fixtureAwsConfig);
});
test("credentials require a live primary role and valid origin, including after validation finishes", async () => {
	await expect(
		awsApi(request("/api/admin/aws"), stranger, aws.send),
	).rejects.toMatchObject({ status: 403 });
	expect(
		(await awsApi(
			request(
				"/api/admin/aws",
				"PUT",
				fixtureAwsConfig,
				"https://foreign.example",
			),
			owner,
			aws.send,
		))!.status,
	).toBe(403);
	expect(aws.calls).toHaveLength(0);
	aws.onRequest = () => {
		state.db.exec("UPDATE users SET is_primary_admin=0 WHERE id='owner'");
	};
	await expect(
		awsApi(request("/api/admin/aws", "PUT", fixtureAwsConfig), owner, aws.send),
	).rejects.toMatchObject({ status: 403 });
	expect(await getAwsConfig()).toBeNull();
});
test("SES identities publish only missing DKIM records and retain sandbox/domain status", async () => {
	await configure();
	const domain = await getDomain(owner, "domain");
	const view = await setupSesSending(domain, client(), dns.client);
	expect(view).toMatchObject({
		registered: true,
		verified: true,
		dkimStatus: "SUCCESS",
		missingDns: 0,
		dnsManaged: true,
		productionAccess: false,
		region: "us-east-1",
	});
	expect(dns.records).toHaveLength(3);
	await setupSesSending(domain, client(), dns.client);
	expect(dns.records).toHaveLength(3);
	const summary = await domainsApi(
		request("/api/domains/domain/sending"),
		owner,
		dns.client,
		undefined,
		aws.send,
	);
	expect(await summary!.json()).toMatchObject({ ses: true, sesVerified: true });
});
test("manual sending configuration and access-denied views preserve the source UI contracts", async () => {
	await configure();
	state.db.exec("UPDATE domains SET zone_id='manual'");
	const setup = await awsDomainApi(
		request("/api/domains/domain/ses", "POST", { action: "setup" }),
		owner,
		undefined,
		aws.send,
	);
	expect(await setup!.json()).toMatchObject({
		ses: { registered: true, dnsManaged: false, missingDns: null },
	});
	aws.denied.add("Identity");
	expect(
		await (await awsDomainApi(
			request("/api/domains/domain/ses"),
			owner,
			undefined,
			aws.send,
		))!.json(),
	).toMatchObject({
		credentials: true,
		ses: null,
		error:
			"These AWS credentials cannot manage SES identities. Re-check them under AWS credentials.",
	});
});
test("receiving preserves an active rule set and other subscriptions, and persists the token before confirmation arrives", async () => {
	await configure();
	aws.activeRuleSet = "existing-rules";
	aws.rules.set("unrelated", {});
	aws.onSubscribe = async (endpoint, topicArn) => {
		const url = `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(topicArn)}&Token=fixture-confirmation`;
		const response = await sesInbound(
			request(endpoint.replace("https://mail.example.com", ""), "POST", {
				Type: "SubscriptionConfirmation",
				TopicArn: topicArn,
				SubscribeURL: url,
			}),
			aws.send,
		);
		expect(await response.json()).toEqual({ confirmed: true });
	};
	const domain = await getDomain(owner, "domain");
	await setupSesReceiving(
		domain,
		client(),
		"https://mail.example.com",
		false,
		dns.client,
	);
	const saved = await getSesReceivingState();
	expect(saved).toMatchObject({ ruleSet: "existing-rules" });
	expect(aws.rules.has("unrelated")).toBe(true);
	expect(
		aws.calls.some((row) => row.action === "SetActiveReceiptRuleSet"),
	).toBe(false);
	expect(await sesReceivingView(domain, client(), dns.client)).toMatchObject({
		ready: true,
	});
	const token = saved!.token;
	await setupSesReceiving(
		domain,
		client(),
		"https://mail.example.com",
		false,
		dns.client,
	);
	expect((await getSesReceivingState())!.token).toBe(token);
	expect(aws.calls.filter((row) => row.action === "Subscribe")).toHaveLength(1);
});
test("receiving requires MX confirmation and refuses local or unsupported receiving endpoints", async () => {
	await configure();
	dns.addRecord({
		type: "MX",
		name: "example.com",
		content: "previous.example.net",
		priority: 10,
	});
	const conflict = await awsDomainApi(
		request("/api/domains/domain/receiving/ses", "POST", {}),
		owner,
		dns.client,
		aws.send,
	);
	expect(conflict!.status).toBe(409);
	expect(await conflict!.json()).toMatchObject({ code: "MX_CONFLICT" });
	expect(
		dns.records.some((row) => row.content === "previous.example.net"),
	).toBe(true);
	expect(
		(await awsDomainApi(
			request("/api/domains/domain/receiving/ses", "POST", { replaceMx: true }),
			owner,
			dns.client,
			aws.send,
		))!.status,
	).toBe(200);
	expect(
		dns.records.some((row) => row.content === "previous.example.net"),
	).toBe(false);
	const count = aws.calls.length;
	await expect(
		setupSesReceiving(
			await getDomain(owner, "domain"),
			client(),
			"http://localhost:3000",
			true,
			dns.client,
		),
	).rejects.toThrow("public HTTPS");
	await expect(
		setupSesReceiving(
			await getDomain(owner, "domain"),
			new AwsClient(
				{ ...fixtureAwsConfig, region: "ap-northeast-2" },
				aws.send,
			),
			"https://mail.example.com",
			true,
			dns.client,
		),
	).rejects.toThrow("cannot receive");
	expect(aws.calls).toHaveLength(count);
});
test("cleanup preserves a receiving identity and the MX still used by Resend", async () => {
	const saved = await receiving();
	await expect(
		removeSesSending(await getDomain(owner, "domain"), client(), dns.client),
	).rejects.toMatchObject({ status: 400 });
	expect(aws.identities.has("example.com")).toBe(true);
	state.db.exec("UPDATE domains SET receiving_provider='resend'");
	const removed = await awsDomainApi(
		request("/api/domains/domain/receiving", "DELETE", { target: "ses" }),
		owner,
		dns.client,
		aws.send,
	);
	expect(removed!.status).toBe(200);
	expect(aws.rules.size).toBe(0);
	expect(
		dns.records.some(
			(row) => row.content === "inbound-smtp.us-east-1.amazonaws.com",
		),
	).toBe(true);
	expect(aws.buckets.has(saved.bucket)).toBe(true);
	expect(aws.topics.has(saved.topicArn)).toBe(true);
});
test("SES sends direct and scheduled attachments with signed JSON, inline CIDs and provider-owned Message-ID", async () => {
	await configure();
	const draft = await saveDraft(owner, {
			mailboxId: "mailbox",
			to: "recipient@example.net",
			cc: "copy@example.net",
			bcc: "hidden@example.net",
			subject: "SES reply",
			text: "Body",
			html: "<p>Body</p>",
			inReplyTo: "<parent@example.net>",
		}),
		content = crypto.getRandomValues(new Uint8Array(4099));
	const uploaded = await uploadAttachments(owner, draft.id, [
		new File([content], "inline.bin", { type: "application/octet-stream" }),
	]);
	state.db
		.query(
			"UPDATE message_attachments SET disposition='inline',content_id='inline-fixture' WHERE message_id=?",
		)
		.run(draft.id);
	await sendDraft(owner, draft.id, uploaded.draft_revision, aws.send);
	const body = z
		.object({
			Destination: z.object({
				ToAddresses: z.array(z.string()),
				CcAddresses: z.array(z.string()),
				BccAddresses: z.array(z.string()),
			}),
			Content: z.object({
				Simple: z.object({
					Headers: z.array(z.object({ Name: z.string(), Value: z.string() })),
					Attachments: z.array(
						z.object({
							RawContent: z.string(),
							ContentDisposition: z.string(),
							ContentId: z.string(),
						}),
					),
				}),
			}),
		})
		.parse(
			aws.calls.find((row) => row.path === "/v2/email/outbound-emails")?.body,
		);
	expect(
		body.Content.Simple.Headers.some(
			(row) => row.Name.toLowerCase() === "message-id",
		),
	).toBe(false);
	expect(body.Content.Simple.Headers).toContainEqual({
		Name: "In-Reply-To",
		Value: "<parent@example.net>",
	});
	expect(
		Buffer.from(body.Content.Simple.Attachments[0]!.RawContent, "base64"),
	).toEqual(Buffer.from(content));
	expect(body.Content.Simple.Attachments[0]).toMatchObject({
		ContentDisposition: "INLINE",
		ContentId: "inline-fixture",
	});
	expect(
		state.db
			.query("SELECT status,provider_message_id FROM messages WHERE id=?")
			.get(draft.id),
	).toEqual({
		status: "sent",
		provider_message_id: "<ses-message-1@email.amazonses.com>",
	});
	const later = await saveDraft(owner, {
		mailboxId: "mailbox",
		to: "later@example.net",
		cc: "",
		bcc: "",
		html: "",
		subject: "Later SES",
		text: "Body",
		scheduledAt: new Date(Date.now() + 60_000).toISOString(),
	});
	await sendDraft(owner, later.id, later.draft_revision, aws.send);
	state.db.exec(
		"UPDATE outbound_jobs SET scheduled_at=0 WHERE status='queued'",
	);
	const job = z
		.object({ id: z.string() })
		.parse(
			state.db
				.query("SELECT id FROM outbound_jobs WHERE status='queued'")
				.get(),
		);
	await deliverJob(job.id, aws.send);
	expect(
		state.db.query("SELECT status FROM messages WHERE id=?").get(later.id),
	).toEqual({ status: "sent" });
	const staging = join(state.directory, "sending-staging");
	for (const directory of await readdir(staging))
		expect(await readdir(join(staging, directory))).toHaveLength(0);
});
test("SES failures retain editable drafts and clean private staged payloads", async () => {
	await configure();
	aws.sendStatus = 503;
	const draft = await saveDraft(owner, {
		mailboxId: "mailbox",
		to: "recipient@example.net",
		cc: "",
		bcc: "",
		html: "",
		subject: "SES failure",
		text: "Body",
	});
	await expect(
		sendDraft(owner, draft.id, draft.draft_revision, aws.send),
	).rejects.toThrow("Synthetic SES send failure");
	expect((await getDraft(owner, draft.id)).status).toBe("draft");
	for (const name of await readdir(join(state.directory, "sending-staging")))
		expect(
			await readdir(join(state.directory, "sending-staging", name)),
		).toHaveLength(0);
});
test("SES system mail has no Sent/contact/outbound-job side effects", async () => {
	await configure();
	expect(
		await sendSystemMail(
			{
				to: "owner@example.com",
				subject: "System SES",
				text: "Body",
				html: "",
				hostname: "example.com",
			},
			aws.send,
		),
	).toBe(true);
	expect(state.db.query("SELECT id FROM outbound_jobs").all()).toHaveLength(0);
	expect(
		state.db.query("SELECT id FROM messages WHERE direction='outbound'").all(),
	).toHaveLength(0);
});
test("SNS intake authenticates token/topic/object scope, consumes raw MIME once and acknowledges retries after deletion", async () => {
	const saved = await receiving(),
		raw = new TextEncoder().encode(
			"From: sender@example.net\r\nTo: hello@example.com\r\nSubject: SES received\r\nMessage-ID: <ses-inbound@example.net>\r\n\r\nProvider content",
		);
	aws.objects.set(saved.bucket + "/inbound/message", raw);
	expect(
		(
			await sesInbound(
				request("/api/inbound/ses?token=wrong", "POST", {}),
				aws.send,
			)
		).status,
	).toBe(403);
	const event = await envelope(notification());
	expect(await (await sesInbound(event, aws.send)).json()).toEqual({
		delivered: 1,
		dropped: null,
	});
	expect(aws.objects.size).toBe(0);
	expect(
		state.db.query("SELECT id FROM mailrun_ses_receipts").all(),
	).toHaveLength(1);
	expect(
		await (await sesInbound(await envelope(notification()), aws.send)).json(),
	).toEqual({ delivered: 1, dropped: null });
	expect(
		aws.calls.filter(
			(row) =>
				row.action === null &&
				row.path === "/inbound/message" &&
				row.method === "GET",
		),
	).toHaveLength(1);
	expect(
		state.db
			.query("SELECT id FROM messages WHERE subject='SES received'")
			.all(),
	).toHaveLength(1);
	const foreign = await envelope(notification("inbound/../private"));
	expect((await sesInbound(foreign, aws.send)).status).toBe(400);
});
test("S3 failures leave raw objects for retry, while completed intake can retry only its failed cleanup", async () => {
	const saved = await receiving();
	aws.objects.set(
		saved.bucket + "/inbound/message",
		new TextEncoder().encode(
			"From: sender@example.net\r\nTo: hello@example.com\r\nSubject: Cleanup recovery\r\n\r\nBody",
		),
	);
	aws.denied.add("GetObject");
	expect(
		(await sesInbound(await envelope(notification()), aws.send)).status,
	).toBe(502);
	expect(aws.objects.size).toBe(1);
	expect(
		state.db.query("SELECT id FROM mailrun_ses_receipts").all(),
	).toHaveLength(0);
	aws.denied.delete("GetObject");
	aws.deleteStatus = 503;
	expect(
		(await sesInbound(await envelope(notification()), aws.send)).status,
	).toBe(502);
	expect(aws.objects.size).toBe(1);
	expect(
		state.db.query("SELECT id FROM mailrun_ses_receipts").all(),
	).toHaveLength(1);
	const gets = aws.calls.filter(
		(row) => row.path === "/inbound/message" && row.method === "GET",
	).length;
	aws.deleteStatus = 204;
	expect(
		(await sesInbound(await envelope(notification()), aws.send)).status,
	).toBe(200);
	expect(
		aws.calls.filter(
			(row) => row.path === "/inbound/message" && row.method === "GET",
		),
	).toHaveLength(gets);
});
test("virus verdicts drop mail before download and subscription confirmation cannot leave its expected SNS topic", async () => {
	const saved = await receiving();
	const event = notification();
	event.receipt.virusVerdict.status = "FAIL";
	aws.objects.set(saved.bucket + "/inbound/message", new Uint8Array([1]));
	expect(
		await (await sesInbound(await envelope(event), aws.send)).json(),
	).toEqual({ dropped: "Message failed the virus scan" });
	expect(
		aws.calls.some(
			(row) => row.method === "GET" && row.path === "/inbound/message",
		),
	).toBe(false);
	const invalid = request("/api/inbound/ses?token=" + saved.token, "POST", {
		Type: "SubscriptionConfirmation",
		TopicArn: saved.topicArn,
		SubscribeURL: "https://foreign.example/?token=" + saved.token,
	});
	expect((await sesInbound(invalid, aws.send)).status).toBe(400);
});
test("staged payloads are private, hashed without materialization and protected from startup cleanup while live", async () => {
	async function* chunks() {
		yield new TextEncoder().encode("private staged body");
	}
	const stage = await stageSendBody(chunks());
	try {
		expect((await stat(stage.file.name!)).mode & 0o777).toBe(0o600);
		expect(stage.payloadHash).toBe(
			new Bun.CryptoHasher("sha256")
				.update("private staged body")
				.digest("hex"),
		);
		await clearSendingStaging();
		expect(await stage.file.exists()).toBe(true);
		const dead = join(
			state.directory,
			"sending-staging",
			process.pid + "-00000000-0000-4000-8000-000000000000",
		);
		await mkdir(dead);
		await Bun.write(join(dead, "abandoned.json"), "stale");
		await clearSendingStaging();
		expect(await Bun.file(join(dead, "abandoned.json")).exists()).toBe(false);
	} finally {
		await stage.close();
	}
});
test("SES completion receipts restore before/after migration 0066 while old full backups remain valid", async () => {
	const legacyPath = join(state.directory, "before-ses.sqlite"),
		legacy = new Database(legacyPath);
	legacy.exec(
		"CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TEXT DEFAULT CURRENT_TIMESTAMP)",
	);
	try {
		for (const [name, file] of getMigrations())
			if (name.endsWith(".sql") && name.slice(0, 4) < "0066") {
				legacy.exec(await file.text());
				legacy.query("INSERT INTO d1_migrations(name) VALUES(?)").run(name);
			}
		const empty = join(state.directory, "ses-empty.json");
		await writeBackup(state.path, empty);
		restoreBackup(legacy, await Bun.file(empty).json());
		const old = join(state.directory, "ses-old.json");
		await writeBackup(legacyPath, old);
		restoreBackup(legacy, await Bun.file(old).json());
		state.db.exec(
			`INSERT INTO mailrun_ses_receipts VALUES('receipt','{"delivered":1,"dropped":null}',1)`,
		);
		const current = join(state.directory, "ses-current.json");
		await writeBackup(state.path, current);

		const document = await Bun.file(current).json();
		expect(() => restoreBackup(legacy, document)).toThrow(
			"Apply migrations before restoring mailrun_ses_receipts",
		);
		await migrate(legacyPath);
		restoreBackup(legacy, document);
		expect(
			legacy.query("SELECT id FROM mailrun_ses_receipts").all(),
		).toHaveLength(1);
		expect(
			coveredTables(legacy).filter((name) => name === "mailrun_ses_receipts"),
		).toHaveLength(1);
		restoreBackup(legacy, await Bun.file(old).json());
		expect(
			legacy.query("SELECT id FROM mailrun_ses_receipts").all(),
		).toHaveLength(0);
	} finally {
		legacy.close();
	}
});

test("two in-flight SNS callbacks converge on the committed receipt when the first consumes their object", async () => {
	const saved = await receiving();
	aws.objects.set(
		saved.bucket + "/inbound/race",
		new TextEncoder().encode(
			"From: sender@example.net\r\nTo: hello@example.com\r\nSubject: Concurrent SES\r\n\r\nBody",
		),
	);
	let count = 0,
		firstEntered = () => {},
		secondEntered = () => {},
		releaseSecond = () => {};
	const firstStarted = new Promise<void>((resolve) => {
			firstEntered = resolve;
		}),
		entered = new Promise<void>((resolve) => {
			secondEntered = resolve;
		}),
		gate = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
	aws.onRequest = async (request) => {
		if (
			request.method !== "GET" ||
			new URL(request.url).pathname !== "/inbound/race"
		)
			return;
		if (++count === 1) {
			firstEntered();
			await entered;
		} else {
			secondEntered();
			await gate;
		}
	};
	const first = sesInbound(
		await envelope(notification("inbound/race")),
		aws.send,
	);
	// Let this named callback acquire the first GET before starting its rival.
	// Otherwise asynchronous signing can reverse them and deadlock the test gate.
	await firstStarted;
	const second = sesInbound(
		await envelope(notification("inbound/race")),
		aws.send,
	);
	try {
		expect((await first).status).toBe(200);
	} finally {
		releaseSecond();
	}
	expect(await (await second).json()).toEqual({ delivered: 1, dropped: null });
	expect(
		state.db
			.query("SELECT id FROM messages WHERE subject='Concurrent SES'")
			.all(),
	).toHaveLength(1);
});

test("completed SNS receipts remain acknowledgeable after the operator clears AWS credentials", async () => {
	const saved = await receiving();
	aws.objects.set(
		saved.bucket + "/inbound/message",
		new TextEncoder().encode(
			"From: sender@example.net\r\nSubject: Receipt acknowledgement\r\n\r\nBody",
		),
	);
	expect(
		(await sesInbound(await envelope(notification()), aws.send)).status,
	).toBe(200);
	await clearAwsConfig(owner);
	const calls = aws.calls.length;
	expect(
		await (await sesInbound(await envelope(notification()), aws.send)).json(),
	).toEqual({ delivered: 1, dropped: null });
	expect(aws.calls).toHaveLength(calls);
});

test("a restricted or unverified SES identity never reports receiving as ready", async () => {
	await configure();
	aws.autoVerify = false;
	await setupSesReceiving(
		await getDomain(owner, "domain"),
		client(),
		"https://mail.example.com",
		false,
		dns.client,
	);
	const saved = await getSesReceivingState();
	for (const row of aws.topics.get(saved!.topicArn) ?? []) row.confirmed = true;
	expect(
		await sesReceivingView(
			await getDomain(owner, "domain"),
			client(),
			dns.client,
		),
	).toMatchObject({ ready: false });
	aws.denied.add("Identity");
	const unknown = await sesReceivingView(
		await getDomain(owner, "domain"),
		client(),
		dns.client,
	);
	expect(unknown.ready).toBe(false);
	expect(unknown.steps.find((row) => row.key === "rule")?.detail).toContain(
		"could not be checked",
	);
});

test("setup rechecks domain permissions before publishing shared receiving state", async () => {
	await configure();
	aws.onRequest = (request) => {
		if (
			request.method === "PUT" &&
			new URL(request.url).hostname.includes(".s3.")
		)
			state.db.exec("UPDATE users SET is_primary_admin=0 WHERE id='owner'");
	};
	await expect(
		awsDomainApi(
			request("/api/domains/domain/receiving/ses", "POST", {}),
			owner,
			dns.client,
			aws.send,
		),
	).rejects.toMatchObject({ status: 403 });
	expect(await getSesReceivingState()).toBeNull();
});

test("new installations isolate transport resources while restored legacy resources and tokens are reused", async () => {
	const first = await receiving();
	state.db.exec("UPDATE app_settings SET ses_receiving=NULL");
	const domain = {
		...(await getDomain(owner, "domain")),
		hostname: "other.example.com",
		zone_id: "manual",
	};
	await setupSesReceiving(
		domain,
		client(),
		"https://other-mail.example.com",
		false,
	);
	const second = await getSesReceivingState();
	expect(second!.bucket).not.toBe(first.bucket);
	expect(second!.topicArn).not.toBe(first.topicArn);
	const legacy = {
		...first,
		bucket: "mailflare-inbound-123456789012-us-east-1",
		topicArn: "arn:aws:sns:us-east-1:123456789012:mailflare-inbound",
	};
	aws.topics.set(legacy.topicArn, []);
	state.db
		.query("UPDATE app_settings SET ses_receiving=? WHERE id='default'")
		.run(JSON.stringify(legacy));
	await setupSesReceiving(
		await getDomain(owner, "domain"),
		client(),
		"https://mail.example.com",
		false,
		dns.client,
	);
	expect(await getSesReceivingState()).toMatchObject({
		bucket: legacy.bucket,
		topicArn: legacy.topicArn,
		token: legacy.token,
	});
});

test("cleanup preserves another live process payload and removes it after that process exits", async () => {
	const module = resolve("src/server/mail/sending-staging.ts");
	const code = `import {stageSendBody} from ${JSON.stringify(module)};async function* body(){yield new TextEncoder().encode('live cron body');}const value=await stageSendBody(body());console.log(value.file.name);setInterval(()=>{},1000);`;
	const child = Bun.spawn([process.execPath, "-e", code], {
		env: { ...process.env, DATA_DIR: state.directory },
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		const reader = child.stdout.getReader();
		const next = await reader.read();
		reader.releaseLock();
		const path = new TextDecoder().decode(next.value).trim();
		if (!path.startsWith(state.directory))
			throw new Error("Invalid child stage path");
		await clearSendingStaging();
		expect(await Bun.file(path).exists()).toBe(true);
		child.kill("SIGKILL");
		await child.exited;
		await clearSendingStaging();
		expect(await Bun.file(path).exists()).toBe(false);
	} finally {
		child.kill("SIGKILL");
		await child.exited;
	}
});

test("removing old Resend receiving configuration preserves an active SES MX and receipt rule", async () => {
	await receiving();
	const { resendFixture } = await import("./resend-fixture");
	const { ResendClient } = await import("../src/server/resend/client");
	const { removeResendReceiving } = await import(
		"../src/server/resend/domains"
	);
	const resend = resendFixture();
	resend.addDomain("example.com", false, true);
	const before = dns.records
		.filter((row) => row.type === "MX")
		.map((row) => row.content);
	await removeResendReceiving(
		await getDomain(owner, "domain"),
		new ResendClient("re_synthetic-fixture", resend.send),
		dns.client,
	);
	expect(
		dns.records.filter((row) => row.type === "MX").map((row) => row.content),
	).toEqual(before);
	expect(aws.rules.size).toBe(1);
	expect(resend.domains.size).toBe(0);
});

test("SNS topic, bucket and prefix guards reject forged scope before making an AWS request", async () => {
	const saved = await receiving(),
		count = aws.calls.length;
	const make = (TopicArn: string, message: unknown) =>
		request("/api/inbound/ses?token=" + saved.token, "POST", {
			Type: "Notification",
			TopicArn,
			Message: JSON.stringify(message),
		});
	expect(
		(
			await sesInbound(
				make("arn:aws:sns:us-east-1:999999999999:foreign", notification()),
				aws.send,
			)
		).status,
	).toBe(403);
	const foreign = notification();
	foreign.receipt.action.bucketName = "foreign-bucket";
	expect(
		(await sesInbound(make(saved.topicArn, foreign), aws.send)).status,
	).toBe(400);
	const path = notification("private/message");
	path.receipt.action.bucketName = saved.bucket;
	expect((await sesInbound(make(saved.topicArn, path), aws.send)).status).toBe(
		400,
	);
	expect(aws.calls).toHaveLength(count);
});
