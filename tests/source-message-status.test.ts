import { test, expect, beforeEach, afterEach } from "bun:test";
import { fixture, owner, stranger, enableTeamSharing } from "./fixtures";
import { dispatchMailApi, serveMailApi } from "../src/server/api/mail";
import capture from "./source-message-status.json";

let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
function request(messageId: string, status: string) {
	return new Request(`https://mail.example/api/messages/${messageId}/status`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ status }),
	});
}
for (const sample of capture.cases)
	test(`original message status: ${sample.name}`, async () => {
		enableTeamSharing(state.db);
		state.db.exec(
			"INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES('status-folder','owner','mailbox','Status folder',1)",
		);
		state.db
			.query(
				"UPDATE messages SET status=?,direction=?,folder_id='status-folder',snoozed_until=4000000000,trashed_at=123,starred=1,read=0 WHERE id='message'",
			)
			.run(sample.initialStatus, sample.direction ?? "inbound");
		state.db.exec("UPDATE messages SET trashed_at=123 WHERE id='message'");
		if (sample.permission)
			state.db
				.query(
					"INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES('status-share','mailbox','stranger',?,1)",
				)
				.run(sample.permission);
		const started = Math.floor(Date.now() / 1000);
		const response = await dispatchMailApi(
			request(sample.messageId ?? "message", sample.status),
			sample.actor === "owner" ? owner : stranger,
		);
		expect(response.status).toBe(sample.response.status);
		expect(await response.json()).toEqual(sample.response.body);
		const message = state.db
			.query(
				"SELECT status,direction,folder_id,snoozed_until,trashed_at,starred,read FROM messages WHERE id='message'",
			)
			.get() as Record<string, unknown>;
		if (sample.message.trashed_at === "now") {
			expect(message.trashed_at).toBeGreaterThanOrEqual(started);
			expect(message.trashed_at).toBeLessThanOrEqual(
				Math.floor(Date.now() / 1000),
			);
			message.trashed_at = "now";
		}
		expect(message).toEqual(sample.message);
		expect(
			state.db
				.query(
					"SELECT classification FROM spam_feedback WHERE message_id='message'",
				)
				.get(),
		).toEqual(sample.feedback);
		const audit = state.db
			.query("SELECT action,metadata FROM audit_logs ORDER BY created_at,rowid")
			.all()
			.map((row) => {
				const value = row as { action: string; metadata: string | null };
				return {
					action: value.action,
					metadata: value.metadata
						? (JSON.parse(value.metadata) as unknown)
						: null,
				};
			});
		expect(audit).toEqual(sample.audit);
	});

test("status endpoint retains native private-draft and in-flight delivery guards", async () => {
	enableTeamSharing(state.db);
	state.db.exec(
		"INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES('status-share','mailbox','stranger','full_access',1); UPDATE messages SET status='draft' WHERE id='message'",
	);
	const foreign = await dispatchMailApi(request("message", "trash"), stranger);
	expect(foreign.status).toBe(404);
	state.db.exec(
		"UPDATE messages SET status='queued' WHERE id='message'; INSERT INTO outbound_jobs(id,user_id,message_id,status,payload,created_at,updated_at) VALUES('sending','owner','message','sending','{}',1,1)",
	);
	await expect(
		dispatchMailApi(request("message", "trash"), owner),
	).rejects.toMatchObject({ status: 409 });
	expect(
		state.db.query("SELECT status FROM messages WHERE id='message'").get(),
	).toEqual({ status: "queued" });
});

test("the production demo-seed endpoint returns the source refusal before authentication or body parsing", async () => {
	const previous = process.env.NODE_ENV;
	process.env.NODE_ENV = "production";
	try {
		const response = await serveMailApi(
			new Request("https://mail.example/api/seed", {
				method: "POST",
				body: "not JSON",
			}),
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Not available in production",
		});
	} finally {
		if (previous === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = previous;
	}
});
