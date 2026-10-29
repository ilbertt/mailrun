import { afterEach, beforeEach, expect, test } from "bun:test";
import { fixture } from "./fixtures";
import {
	capturedMailSchema,
	expectedSourceMail,
	restoreSourceOutbound,
	sourceOutboundCapture,
	verifySourceObjects,
} from "./source-outbound-fixture";
import { deliverJob } from "../src/server/mail/send";
import {
	saveInstallation,
	setInstallationPhase,
} from "../src/server/cloudflare/installation";
import { deliveryHeaders } from "../src/server/mail/delivery-headers";
import { deliveryPayloadSchema } from "../src/shared/mail-contracts";

let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
	await restoreSourceOutbound(state.db);
	await saveInstallation({
		accountId: "account",
		zoneId: "zone",
		hostname: "example.com",
		workerName: "relay",
		publicOrigin: "https://fixture.example",
		apiToken: "fixture-token",
		relaySecret: "fixture-secret",
		relayVersion: "fixture-version",
	});
	await setInstallationPhase("ready");
});
afterEach(async () => {
	await state.close();
});

test("original exporter jobs retain recipients, array/string references, custom headers, inline files and send audit entries", async () => {
	const delivered: ReturnType<typeof capturedMailSchema.parse>[] = [];
	const send = async (_input: string | URL | Request, init?: RequestInit) => {
		delivered.push(capturedMailSchema.parse(JSON.parse(String(init?.body))));
		return Response.json({
			success: true,
			result: {
				message_id: `<source-delivery-${delivered.length}@example.com>`,
			},
		});
	};
	const payloads = state.db
		.query("SELECT id,payload FROM outbound_jobs ORDER BY id")
		.all();
	for (const item of sourceOutboundCapture.queue)
		await deliverJob(item.jobId, send);
	expect(delivered).toHaveLength(0);
	expect(
		state.db.query("SELECT id,payload FROM outbound_jobs ORDER BY id").all(),
	).toEqual(payloads);
	state.db.exec("UPDATE outbound_jobs SET scheduled_at=0");
	for (const item of sourceOutboundCapture.queue) {
		await deliverJob(item.jobId, send);
		await deliverJob(item.jobId, send);
	}
	expect(delivered).toEqual(expectedSourceMail);
	expect(delivered[2]!.headers.References!.length).toBeGreaterThan(2048);
	expect(state.db.query("SELECT status FROM outbound_jobs").all()).toEqual(
		Array(3).fill({ status: "sent" }),
	);
	expect(
		state.db
			.query(
				"SELECT actor_user_id,mailbox_id,message_id,action,metadata FROM audit_logs WHERE action='email.send' ORDER BY rowid",
			)
			.all(),
	).toEqual(sourceOutboundCapture.expected.audits);
	expect(
		state.db.query("SELECT id,payload FROM outbound_jobs ORDER BY id").all(),
	).toEqual(payloads);
	await verifySourceObjects();
	expect(state.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("imported sent and in-flight jobs are never retried automatically", async () => {
	state.db
		.query("UPDATE outbound_jobs SET status='sent',scheduled_at=0 WHERE id=?")
		.run(sourceOutboundCapture.queue[0]!.jobId);
	state.db
		.query(
			"UPDATE outbound_jobs SET status='sending',scheduled_at=0 WHERE id=?",
		)
		.run(sourceOutboundCapture.queue[1]!.jobId);
	let calls = 0;
	for (const item of sourceOutboundCapture.queue)
		await deliverJob(item.jobId, async () => {
			calls++;
			throw new Error("Unexpected provider call");
		});
	expect(calls).toBe(0);
	expect(
		state.db.query("SELECT status FROM outbound_jobs ORDER BY rowid").all(),
	).toEqual([{ status: "sent" }, { status: "sending" }, { status: "queued" }]);
});

test("restored source jobs recheck sender permissions and require their migrated attachment bytes", async () => {
	state.db.exec(
		"UPDATE outbound_jobs SET scheduled_at=0; DELETE FROM mailbox_aliases",
	);
	let calls = 0;
	await expect(
		deliverJob(sourceOutboundCapture.queue[0]!.jobId, async () => {
			calls++;
			throw new Error("Unexpected send");
		}),
	).rejects.toThrow("not assigned");
	expect(calls).toBe(0);
	state.db.exec(
		"INSERT INTO mailbox_aliases(id,mailbox_id,domain_id,local_part,created_at) VALUES('restored-alias','mailbox','domain','support',1)",
	);
	await new (await import("../src/server/storage")).LocalStorage().delete(
		sourceOutboundCapture.objects.find((file) =>
			file.key.includes(sourceOutboundCapture.queue[1]!.messageId),
		)!.key,
	);
	await expect(
		deliverJob(sourceOutboundCapture.queue[1]!.jobId, async () => {
			calls++;
			throw new Error("Unexpected send");
		}),
	).rejects.toThrow();
	expect(calls).toBe(0);
});

test("source-compatible headers reject injection and oversize chains instead of dropping threading", () => {
	const input = {
		from: "hello@example.com",
		to: "recipient@example.net",
		subject: "Headers",
		text: "Body",
	};
	for (const headers of [
		{ "Bad:Name": "value" },
		{ "X-Test": "value\r\nBcc: hidden@example.net" },
	])
		expect(deliveryPayloadSchema.safeParse({ ...input, headers }).success).toBe(
			false,
		);
	expect(() =>
		deliveryHeaders(
			deliveryPayloadSchema.parse({
				...input,
				references: ["a".repeat(9000), "b".repeat(9000)],
			}),
		),
	).toThrow("16 KB");
	expect(
		deliveryHeaders(
			deliveryPayloadSchema.parse({
				...input,
				headers: { "X-Proof": "preserved" },
				references: ["<root@example.org>", "<parent@example.org>"],
			}),
		),
	).toEqual({
		"X-Proof": "preserved",
		References: "<root@example.org> <parent@example.org>",
	});
});
