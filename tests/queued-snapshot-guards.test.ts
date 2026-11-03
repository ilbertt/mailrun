import { test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import { fixture, owner } from "./fixtures";
import {
	restoreQueuedBefore,
	QUEUED_AT,
	DELIVER_AT,
} from "./queued-delivery-fixture";
import { deliverJob } from "../src/server/mail/send";
import { cancelSessionSend } from "../src/server/mail/session-send";
import capture from "./source-queued-delivery-contracts.json";
let state: Awaited<ReturnType<typeof fixture>>,
	identity: { messageId: string; jobId: string };
beforeEach(async () => {
	state = await fixture();
	setSystemTime(QUEUED_AT);
	identity = await restoreQueuedBefore(
		state.db,
		state.directory,
		capture.cases.find((row) => row.name === "ordinary")!.before,
	);
	setSystemTime(DELIVER_AT);
});
afterEach(async () => {
	setSystemTime();
	await state.close();
});
const accepted = () =>
	Response.json({
		success: true,
		result: { message_id: "<guard@example.net>" },
	});
test("a claimed source-format delivery survives a losing cancellation without a duplicate call", async () => {
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let calls = 0;
	const first = deliverJob(identity.jobId, async () => {
		calls++;
		entered.resolve();
		await release.promise;
		return accepted();
	});
	try {
		await entered.promise;
		await expect(
			cancelSessionSend(owner, identity.messageId),
		).rejects.toMatchObject({ status: 409 });
		await deliverJob(identity.jobId, async () => {
			calls++;
			return accepted();
		});
		expect(calls).toBe(1);
	} finally {
		release.resolve();
		await first;
	}
	expect(
		state.db
			.query("SELECT status FROM outbound_jobs WHERE id=?")
			.get(identity.jobId),
	).toEqual({ status: "sent" });
});
test("cancelling the source-format job first also removes its durable transport identity", async () => {
	await cancelSessionSend(owner, identity.messageId);
	let calls = 0;
	await deliverJob(identity.jobId, async () => {
		calls++;
		return accepted();
	});
	expect(calls).toBe(0);
	expect(
		state.db
			.query("SELECT * FROM mailrun_outbound_snapshots WHERE job_id=?")
			.get(identity.jobId),
	).toBeNull();
	expect(
		state.db
			.query("SELECT status FROM messages WHERE id=?")
			.get(identity.messageId),
	).toEqual({ status: "draft" });
});
test("a mismatched queued author is rejected before contacting the provider", async () => {
	const row = state.db
		.query("SELECT payload FROM outbound_jobs WHERE id=?")
		.get(identity.jobId) as { payload: string };
	const payload: Record<string, unknown> = JSON.parse(row.payload);
	payload.userId = "stranger";
	state.db
		.query("UPDATE outbound_jobs SET payload=? WHERE id=?")
		.run(JSON.stringify(payload), identity.jobId);
	let calls = 0;
	await expect(
		deliverJob(identity.jobId, async () => {
			calls++;
			return accepted();
		}),
	).rejects.toThrow("Queued sender does not match its job");
	expect(calls).toBe(0);
});
test("older Bun job envelopes without original identity fields retain live sender checks", async () => {
	identity = await restoreQueuedBefore(
		state.db,
		state.directory,
		capture.cases.find((row) => row.name === "alias-removed")!.before,
	);
	state.db.exec("DELETE FROM mailbox_aliases");
	const row = state.db
		.query("SELECT payload FROM outbound_jobs WHERE id=?")
		.get(identity.jobId) as { payload: string };
	const payload: Record<string, unknown> = JSON.parse(row.payload);
	delete payload.userId;
	delete payload.mailboxId;
	state.db
		.query("UPDATE outbound_jobs SET payload=? WHERE id=?")
		.run(JSON.stringify(payload), identity.jobId);
	let calls = 0;
	await expect(
		deliverJob(identity.jobId, async () => {
			calls++;
			return accepted();
		}),
	).rejects.toThrow("not assigned");
	expect(calls).toBe(0);
});
