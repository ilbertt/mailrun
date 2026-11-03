import { test, expect, beforeEach, afterEach } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { fixture, owner, stranger } from "./fixtures";
import {
	createWebhook,
	updateWebhook,
	deleteWebhook,
	listWebhooks,
	webhookDetails,
	listDeliveries,
	createTestDelivery,
	enqueueWebhooks,
} from "../src/server/webhooks/repository";
import {
	runWebhookDelivery,
	runWebhookJobs,
	getRetryDelaySeconds,
	type WebhookFetch,
} from "../src/server/webhooks/delivery";
import {
	startWebhookDispatcher,
	wakeWebhookDispatcher,
} from "../src/server/webhooks/dispatcher";
import { adminWrite } from "../src/server/admin/accounts";
import { storeInbound } from "../src/server/mail/inbound";
import { sendDraft } from "../src/server/mail/send";
import { saveDraft } from "../src/server/mail/drafts";
import { saveInstallation } from "../src/server/cloudflare/installation";
import { seconds } from "../src/server/db";
import {
	runManualBackup,
	downloadBackup,
	restoreRecords,
} from "../src/server/backups/service";
let state: Awaited<ReturnType<typeof fixture>>;
let stopDispatcher: (() => Promise<void>) | undefined;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await stopDispatcher?.();
	stopDispatcher = undefined;
	await state.close();
});
const hookInput = {
	url: "https://hooks.example.net/events",
	description: "Mail events",
	events: ["message.inbound", "message.outbound", "message.failed"],
	maxAttempts: 2,
};
const success: WebhookFetch = async () => new Response(null, { status: 204 });
const defer = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => (resolve = done));
	return { promise, resolve };
};
async function signature(secret: string, body: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return Buffer.from(
		await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
	).toString("hex");
}
async function queued(
	type:
		| "message.inbound"
		| "message.outbound"
		| "message.failed" = "message.inbound",
) {
	await adminWrite((sql) =>
		enqueueWebhooks(sql, owner.id, type, {
			messageId: "message",
			from: "sender@example.org",
		}),
	);
	return state.db
		.query<{ id: string }, []>(
			"SELECT id FROM webhook_deliveries ORDER BY rowid DESC LIMIT 1",
		)
		.get()!.id;
}

test("webhook management requires the current primary admin, preserves ownership and reveals secrets only on create/rotate", async () => {
	await expect(createWebhook(stranger, hookInput)).rejects.toMatchObject({
		status: 403,
	});
	const hook = await createWebhook(owner, hookInput);
	expect(hook.secret).toStartWith("whsec_");
	expect(await webhookDetails(owner, hook.id)).toMatchObject({
		enabled: true,
		maxAttempts: 2,
		events: hookInput.events,
	});
	expect(JSON.stringify(await listWebhooks(owner))).not.toContain(hook.secret);
	const rotated = await updateWebhook(owner, hook.id, {
		description: null,
		rotateSecret: true,
		maxAttempts: 4,
	});
	expect(rotated.secret).toBeString();
	expect(rotated.secret).not.toBe(hook.secret);
	expect(await webhookDetails(owner, hook.id)).toMatchObject({
		description: null,
		maxAttempts: 4,
	});
	state.db.exec(
		"UPDATE users SET role='admin',is_primary_admin=1 WHERE id='stranger'",
	);
	expect(
		await listWebhooks({ ...stranger, role: "admin", isPrimaryAdmin: true }),
	).toEqual([]);
	await expect(webhookDetails(stranger, hook.id)).rejects.toMatchObject({
		status: 404,
	});
	await expect(deleteWebhook(stranger, hook.id)).rejects.toMatchObject({
		status: 404,
	});
	state.db.exec("UPDATE users SET is_primary_admin=0 WHERE id='owner'");
	await expect(
		updateWebhook(owner, hook.id, { enabled: false }),
	).rejects.toMatchObject({ status: 403 });
});
test("webhook validation bounds events, attempts, URLs and partial mutations", async () => {
	for (const input of [
		{ ...hookInput, url: "file:///app/data/mailflare.sqlite" },
		{ ...hookInput, url: "https://username:password@example.net" },
		{ ...hookInput, events: [] },
		{ ...hookInput, events: ["unknown"] },
		{ ...hookInput, maxAttempts: 0 },
		{ ...hookInput, maxAttempts: 11 },
	])
		await expect(createWebhook(owner, input)).rejects.toThrow();
	const hook = await createWebhook(owner, {
		...hookInput,
		url: "http://127.0.0.1:9999/local",
	});
	await expect(updateWebhook(owner, hook.id, {})).rejects.toMatchObject({
		status: 400,
	});
	await updateWebhook(owner, hook.id, { enabled: false });
	expect(await webhookDetails(owner, hook.id)).toMatchObject({
		enabled: false,
		url: "http://127.0.0.1:9999/local",
		maxAttempts: 2,
	});
});
test("inbound events commit with the message, match enabled subscriptions and are not duplicated on relay replay", async () => {
	const hook = await createWebhook(owner, hookInput),
		disabled = await createWebhook(owner, hookInput);
	await updateWebhook(owner, disabled.id, { enabled: false });
	await createWebhook(owner, { ...hookInput, events: ["message.outbound"] });
	const raw = new TextEncoder().encode(
		"From: Sender <sender@example.org>\r\nTo: Display <hello@example.com>\r\nCc: copy@example.org\r\nSubject: Webhook MIME\r\nMessage-ID: <hook@example.org>\r\n\r\nPrivate body omitted from webhook",
	);
	const received = await storeInbound(
		"sender@example.org",
		"hello@example.com",
		raw,
	);
	await storeInbound("sender@example.org", "hello@example.com", raw);
	if (received.action !== "store") throw new Error("Expected inbound store");
	const deliveries = await listDeliveries(owner, hook.id);
	expect(deliveries).toHaveLength(1);
	expect(JSON.parse(deliveries[0]!.payload)).toMatchObject({
		type: "message.inbound",
		data: {
			messageId: received.messageId,
			from: '"Sender" <sender@example.org>',
			to: "hello@example.com",
			cc: "copy@example.org",
			subject: "Webhook MIME",
		},
	});
	expect(deliveries[0]!.payload).not.toContain("Private body");
	expect(
		state.db.query("SELECT id FROM webhook_deliveries").all(),
	).toHaveLength(1);
	await expect(
		adminWrite(async (sql) => {
			await enqueueWebhooks(sql, owner.id, "message.inbound", {
				messageId: "rolled-back",
			});
			throw new Error("rollback");
		}),
	).rejects.toThrow("rollback");
	expect(
		state.db.query("SELECT id FROM webhook_deliveries").all(),
	).toHaveLength(1);
});
test("delivery signs the exact original payload and headers, records HTTP results and keeps secrets out of history", async () => {
	const hook = await createWebhook(owner, hookInput),
		deliveryId = await queued();
	const result = await runWebhookDelivery(
		deliveryId,
		{},
		async (input, init) => {
			expect(String(input)).toBe(hookInput.url);
			expect(init?.method).toBe("POST");
			expect(init?.redirect).toBe("manual");
			const headers = new Headers(init?.headers),
				body = String(init?.body);
			expect(headers.get("x-email-platform-signature")).toBe(
				await signature(hook.secret, body),
			);
			expect(headers.get("x-email-platform-event")).toBe("message.inbound");
			expect(headers.get("x-email-platform-delivery")).toBe(deliveryId);
			expect(headers.get("x-email-platform-attempt")).toBe("1");
			expect(JSON.parse(body)).toEqual({
				type: "message.inbound",
				data: { messageId: "message", from: "sender@example.org" },
			});
			return new Response("accepted", { status: 202 });
		},
	);
	expect(result).toEqual({ status: "delivered" });
	const history = await listDeliveries(owner, hook.id);
	expect(history[0]).toMatchObject({
		attempts: 1,
		responseStatus: 202,
		nextRetryAt: null,
		error: null,
		status: "delivered",
	});
	expect(JSON.stringify(history)).not.toContain(hook.secret);
	expect((await listWebhooks(owner))[0]?.stats).toMatchObject({
		total: 1,
		delivered: 1,
		failing: 0,
		pending: 0,
	});
	expect((await listWebhooks(owner))[0]!.stats.lastAttemptAt).toBeGreaterThan(
		1e12,
	);
});
test("persisted retry dates enforce backoff, exhaustion and explicit retries beyond the configured maximum", async () => {
	const hook = await createWebhook(owner, hookInput),
		id = await queued();
	let calls = 0;
	const fail: WebhookFetch = async () => {
		calls++;
		return new Response("Unavailable", { status: 503 });
	};
	expect(await runWebhookDelivery(id, {}, fail)).toEqual({
		status: "retrying",
	});
	expect((await listDeliveries(owner, hook.id))[0]).toMatchObject({
		attempts: 1,
		responseStatus: 503,
		error: "Unavailable",
	});
	const next = state.db
		.query<{ next_retry_at: number }, []>(
			"SELECT next_retry_at FROM webhook_deliveries",
		)
		.get()!.next_retry_at;
	expect(next - seconds()).toBeGreaterThanOrEqual(59);
	await runWebhookJobs(fail);
	expect(calls).toBe(1);
	state.db.exec("UPDATE webhook_deliveries SET next_retry_at=0");
	await runWebhookJobs(fail);
	expect(calls).toBe(2);
	expect((await listDeliveries(owner, hook.id))[0]).toMatchObject({
		attempts: 2,
		status: "exhausted",
		nextRetryAt: null,
	});
	await runWebhookJobs(fail);
	expect(calls).toBe(2);
	expect(
		await runWebhookDelivery(
			id,
			{ user: owner, webhookId: hook.id, manual: true },
			success,
		),
	).toEqual({ status: "delivered" });
	expect((await listDeliveries(owner, hook.id))[0]?.attempts).toBe(3);
	expect([1, 2, 3, 8, 9, 100].map(getRetryDelaySeconds)).toEqual([
		60, 120, 240, 3600, 3600, 3600,
	]);
});
test("redirects are not followed, error bodies are bounded and successful bodies are cancelled", async () => {
	const hook = await createWebhook(owner, hookInput),
		id = await queued();
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("Error ".repeat(100_000)));
		},
		cancel() {
			cancelled = true;
		},
	});
	await runWebhookDelivery(
		id,
		{},
		async () => new Response(stream, { status: 500 }),
	);
	expect(cancelled).toBe(true);
	expect((await listDeliveries(owner, hook.id))[0]?.error?.length).toBe(500);
	await runWebhookDelivery(id, { manual: true }, async (_, init) => {
		expect(init?.redirect).toBe("manual");
		return new Response(null, {
			status: 302,
			headers: { Location: "http://169.254.169.254/" },
		});
	});
	expect((await listDeliveries(owner, hook.id))[0]).toMatchObject({
		status: "exhausted",
		responseStatus: 302,
		error: "Endpoint responded with 302",
	});
	await runWebhookDelivery(id, { manual: true }, async () => {
		throw new Error("Network unavailable");
	});
	expect((await listDeliveries(owner, hook.id))[0]?.error).toBe(
		"Network unavailable",
	);
});
test("overlapping manual and cron attempts share the same lease and cannot double-post", async () => {
	const hook = await createWebhook(owner, hookInput),
		id = await queued(),
		started = defer<void>(),
		finish = defer<Response>();
	let calls = 0;
	const first = runWebhookDelivery(
		id,
		{ user: owner, webhookId: hook.id, manual: true },
		async () => {
			calls++;
			started.resolve();
			return finish.promise;
		},
	);
	await started.promise;
	await expect(
		runWebhookDelivery(
			id,
			{ user: owner, webhookId: hook.id, manual: true },
			success,
		),
	).rejects.toMatchObject({ status: 409 });
	expect(await runWebhookJobs(success)).toBe(0);
	finish.resolve(new Response(null, { status: 204 }));
	await first;
	expect(calls).toBe(1);
	expect((await listDeliveries(owner, hook.id))[0]?.attempts).toBe(1);
	expect(state.db.query("SELECT name FROM mailrun_job_leases").all()).toEqual(
		[],
	);
});
test("an expired attempt cannot overwrite a newer completed attempt", async () => {
	const hook = await createWebhook(owner, hookInput),
		id = await queued(),
		started = defer<void>(),
		finish = defer<Response>();
	const first = runWebhookDelivery(id, { manual: true }, async () => {
		started.resolve();
		return finish.promise;
	});
	await started.promise;
	state.db.exec("UPDATE mailrun_job_leases SET expires_at=0");
	await runWebhookDelivery(id, { manual: true }, success);
	finish.resolve(new Response("stale failure", { status: 500 }));
	await expect(first).rejects.toMatchObject({ status: 409 });
	expect((await listDeliveries(owner, hook.id))[0]).toMatchObject({
		status: "delivered",
		attempts: 2,
		error: null,
		responseStatus: 204,
	});
});
test("test events retain the original synthetic contract, retries bind the hook and deletion cascades history", async () => {
	const hook = await createWebhook(owner, hookInput),
		other = await createWebhook(owner, hookInput),
		id = await createTestDelivery(owner, hook.id);
	expect(
		await runWebhookDelivery(
			id,
			{ user: owner, webhookId: other.id, manual: true },
			success,
		),
	).toBeNull();
	await runWebhookDelivery(
		id,
		{ user: owner, webhookId: hook.id, manual: true },
		async (_, init) => {
			expect(JSON.parse(String(init?.body))).toEqual({
				type: "message.inbound",
				test: true,
				data: {
					messageId: "test",
					from: "postmaster@example.com",
					to: "inbox@example.com",
					subject: "Mailflare test delivery",
				},
			});
			return new Response(null, { status: 204 });
		},
	);
	await deleteWebhook(owner, hook.id);
	expect(state.db.query("SELECT id FROM webhook_deliveries").all()).toEqual([]);
	expect(await runWebhookDelivery(id, {}, success)).toBeNull();
});
test("automatic retries recover an interrupted attempt and honor the current maximum", async () => {
	const hook = await createWebhook(owner, hookInput),
		id = await queued();
	state.db.exec(
		"UPDATE webhook_deliveries SET attempts=1,next_retry_at=0,status='pending'",
	);
	expect(await runWebhookJobs(success)).toBe(1);
	expect((await listDeliveries(owner, hook.id))[0]).toMatchObject({
		status: "delivered",
		attempts: 2,
	});
	state.db.exec(
		"UPDATE webhook_deliveries SET status='pending',next_retry_at=0",
	);
	let called = false;
	await runWebhookJobs(async () => {
		called = true;
		return new Response(null, { status: 204 });
	});
	expect(called).toBe(false);
	expect((await listDeliveries(owner, hook.id))[0]?.status).toBe("exhausted");
});
test("backup restore retains webhook subscriptions and pending work while excluding process leases", async () => {
	const hook = await createWebhook(owner, hookInput),
		id = await queued();
	const backupId = await runManualBackup(owner),
		document: unknown = await (await downloadBackup(owner, backupId)).json();
	await deleteWebhook(owner, hook.id);
	await restoreRecords(owner, document);
	expect((await listWebhooks(owner))[0]?.id).toBe(hook.id);
	expect(await runWebhookJobs(success)).toBe(1);
	expect((await listDeliveries(owner, hook.id))[0]).toMatchObject({
		id,
		status: "delivered",
	});
});
test("eager dispatch escapes the request context and does not wait for a slow endpoint", async () => {
	await createWebhook(owner, hookInput);
	const requestContext = new AsyncLocalStorage<string>(),
		started = defer<void>(),
		finish = defer<Response>();
	let seenContext: string | undefined;
	stopDispatcher = startWebhookDispatcher(async () => {
		seenContext = requestContext.getStore();
		started.resolve();
		return finish.promise;
	});
	try {
		await requestContext.run("request-with-large-MIME", async () => {
			await queued();
			wakeWebhookDispatcher();
		});
		await started.promise;
		expect(seenContext).toBeUndefined();
		expect(
			state.db.query("SELECT status FROM webhook_deliveries").get(),
		).toEqual({ status: "pending" });
	} finally {
		finish.resolve(new Response(null, { status: 204 }));
		await stopDispatcher();
		stopDispatcher = undefined;
	}
	expect(state.db.query("SELECT status FROM webhook_deliveries").get()).toEqual(
		{ status: "delivered" },
	);
});
test("outbound success and failure queue the source events without message bodies or Bcc", async () => {
	const hook = await createWebhook(owner, hookInput);
	await saveInstallation({
		accountId: "a".repeat(32),
		zoneId: "b".repeat(32),
		hostname: "example.com",
		workerName: "fixture",
		publicOrigin: "https://mail.example.com",
		auth: { kind: "token" as const, token: "synthetic-only" },
		relaySecret: "secret",
		relayVersion: "fixture",
	});
	const input = {
		mailboxId: "mailbox",
		to: "recipient@example.net",
		cc: "copy@example.net",
		bcc: "private@example.net",
		text: "Private sent content",
		html: "",
		subject: "Outbound event",
	};
	const first = await saveDraft(owner, input);
	await sendDraft(owner, first.id, first.draft_revision, async () =>
		Response.json({ success: true, result: { message_id: "provider-id" } }),
	);
	const second = await saveDraft(owner, input);
	await expect(
		sendDraft(owner, second.id, second.draft_revision, async () =>
			Response.json(
				{ success: false, errors: [{ message: "Provider unavailable" }] },
				{ status: 503 },
			),
		),
	).rejects.toThrow("Provider unavailable");
	const deliveries = await listDeliveries(owner, hook.id);
	expect(deliveries).toHaveLength(2);
	expect(
		JSON.parse(
			deliveries.find((row) => row.eventType === "message.outbound")!.payload,
		),
	).toEqual({
		type: "message.outbound",
		data: {
			messageId: first.id,
			providerMessageId: "provider-id",
			to: "recipient@example.net",
			cc: "copy@example.net",
		},
	});
	expect(
		JSON.parse(
			deliveries.find((row) => row.eventType === "message.failed")!.payload,
		),
	).toMatchObject({
		type: "message.failed",
		data: { messageId: second.id, error: "Provider unavailable" },
	});
	expect(JSON.stringify(deliveries)).not.toContain("Private sent content");
	expect(JSON.stringify(deliveries)).not.toContain("private@example.net");
});

test("independent Bun processes cannot claim the same delivery while an endpoint is waiting", async () => {
	const release = defer<void>();
	let posts = 0;
	const endpoint = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch() {
			posts++;
			await release.promise;
			return new Response(null, { status: 204 });
		},
	});
	const hook = await createWebhook(owner, {
			...hookInput,
			url: endpoint.url.href,
		}),
		deliveryId = await queued();
	const modulePath = new URL(
		"../src/server/webhooks/delivery.ts",
		import.meta.url,
	).pathname;
	const children = [0, 1].map(() =>
		Bun.spawn(
			[
				process.execPath,
				"-e",
				`import {runWebhookDelivery} from ${JSON.stringify(modulePath)};try{const result=await runWebhookDelivery(${JSON.stringify(deliveryId)},{manual:true});console.log(result?.status);}catch(error){console.log(error instanceof Response?error.status:500);}`,
			],
			{
				cwd: process.cwd(),
				env: {
					PATH: process.env.PATH,
					HOME: process.env.HOME,
					TMPDIR: process.env.TMPDIR,
					DATA_DIR: state.directory,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		),
	);
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const first = await Promise.race([
			...children.map(async (child) => ({ child, code: await child.exited })),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error("Competing webhook attempt did not finish")),
					5_000,
				);
			}),
		]);
		clearTimeout(timeout);
		expect(first.code).toBe(0);
		expect((await new Response(first.child.stdout).text()).trim()).toBe("409");
		release.resolve();
		expect(await Promise.all(children.map((child) => child.exited))).toEqual([
			0, 0,
		]);
		expect(posts).toBe(1);
		expect((await listDeliveries(owner, hook.id))[0]).toMatchObject({
			status: "delivered",
			attempts: 1,
		});
	} finally {
		clearTimeout(timeout);
		release.resolve();
		await Promise.all(children.map((child) => child.exited));
		await endpoint.stop(true);
	}
});
test("the startup dispatcher recovers pending deliveries and drains more than one batch", async () => {
	const hook = await createWebhook(owner, hookInput),
		complete = defer<void>();
	let posts = 0;
	await adminWrite(async (sql) => {
		for (let i = 0; i < 25; i++)
			await enqueueWebhooks(sql, owner.id, "message.inbound", {
				messageId: `pending-${i}`,
			});
	});
	stopDispatcher = startWebhookDispatcher(async () => {
		if (++posts === 25) complete.resolve();
		return new Response(null, { status: 204 });
	});
	await complete.promise;
	await stopDispatcher();
	stopDispatcher = undefined;
	expect(posts).toBe(25);
	expect((await listWebhooks(owner))[0]?.stats).toMatchObject({
		total: 25,
		delivered: 25,
		pending: 0,
	});
	expect(
		(await listDeliveries(owner, hook.id, 100)).every(
			(row) => row.attempts === 1,
		),
	).toBe(true);
});
