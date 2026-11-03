import { test, expect, beforeEach, afterEach } from "bun:test";
import { fixture, owner, stranger, enableTeamSharing } from "./fixtures";
import { dispatchMailApi } from "../src/server/api/mail";
import { apiErrorResponse } from "../src/server/api/errors";
import capture from "./source-message-actions.json";

let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
for (const sample of capture.cases)
	test(`original message action: ${sample.name}`, async () => {
		enableTeamSharing(state.db);
		state.db.exec(
			"INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES('action-folder','owner','mailbox','Action folder',1)",
		);
		state.db
			.query("UPDATE mailboxes SET type=?,disabled=? WHERE id='mailbox'")
			.run(sample.personal ? "personal" : "shared", sample.disabled ?? 0);
		if (sample.team === false)
			state.db.exec(
				"UPDATE license_settings SET plan='free' WHERE id='default'",
			);
		state.db
			.query(
				"UPDATE messages SET status=?,direction=?,folder_id='action-folder',snoozed_until=4000000000,read=?,starred=? WHERE id='message'",
			)
			.run(
				sample.status ?? "received",
				sample.direction ?? "inbound",
				sample.read ?? 0,
				sample.starred ?? 0,
			);
		state.db.exec("UPDATE messages SET trashed_at=123 WHERE id='message'");
		if (sample.permission)
			state.db
				.query(
					"INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES('action-share','mailbox','stranger',?,1)",
				)
				.run(sample.permission);
		const request = new Request(
			`https://mail.example/api/messages/${sample.messageId ?? "message"}/${sample.action}`,
			{
				method: sample.method,
				headers: { "Content-Type": "application/json" },
				body:
					sample.action === "snooze" && sample.method === "POST"
						? JSON.stringify({ snoozedUntil: sample.until })
						: "not JSON",
			},
		);
		let response: Response;
		try {
			response = await dispatchMailApi(
				request,
				sample.actor === "owner" ? owner : stranger,
			);
		} catch (error) {
			response = await apiErrorResponse(error);
		}
		expect(response.status).toBe(sample.response.status);
		expect(await response.json()).toEqual(sample.response.body);
		expect(
			state.db
				.query(
					"SELECT status,direction,folder_id,snoozed_until,trashed_at,starred,read FROM messages WHERE id='message'",
				)
				.get(),
		).toEqual(sample.message);
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

test("single-message actions retain the native private-draft boundary", async () => {
	enableTeamSharing(state.db);
	state.db.exec(
		"INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES('private-share','mailbox','stranger','full_access',1); UPDATE messages SET status='draft',snoozed_until=4000000000 WHERE id='message'",
	);
	for (const [action, method] of [
		["read", "POST"],
		["star", "POST"],
		["snooze", "DELETE"],
	] as const) {
		let response: Response;
		try {
			response = await dispatchMailApi(
				new Request(`https://mail.example/api/messages/message/${action}`, {
					method,
				}),
				stranger,
			);
		} catch (error) {
			response = await apiErrorResponse(error);
		}
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Message not found" });
	}
	expect(
		state.db
			.query(
				"SELECT read,starred,snoozed_until FROM messages WHERE id='message'",
			)
			.get(),
	).toEqual({ read: 0, starred: 0, snoozed_until: 4000000000 });
	expect(state.db.query("SELECT count(*) AS n FROM audit_logs").get()).toEqual({
		n: 0,
	});
});
