import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { fixture, owner } from "./fixtures";
import {
	prepareJmapSubmission,
	jmapSubmissionRequest,
	JMAP_SUBMISSION_ORIGIN,
} from "./jmap-submission-fixture";
import { handleJmapRequest } from "../src/server/jmap/handler";
import { LocalStorage } from "../src/server/storage";
import { queueSourceSend } from "../src/server/mail/session-send";
import { cleanupSubmittedDraft } from "../src/server/mail/submission-drafts";
import { runJob } from "../src/server/jobs/runner";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
for (const [name, mutation] of [
	["key-revoked", "DELETE FROM api_keys"],
	["mailbox-revoked", "DELETE FROM mcp_key_mailboxes"],
	[
		"newer-draft",
		"UPDATE messages SET draft_revision=draft_revision+1,text_body='Newer edit' WHERE id='draft'",
	],
] as const)
	test(
		"JMAP publication rejects " +
			name +
			" during file copying without publishing partial records",
		async () => {
			const sample = { name };
			await prepareJmapSubmission(state.db, state.directory, sample);
			const original = LocalStorage.prototype.put;
			let copied = false;
			const put = spyOn(LocalStorage.prototype, "put").mockImplementation(
				async function (this: LocalStorage, key, body) {
					await original.call(this, key, body);
					if (key.startsWith("attachments/")) {
						copied = true;
						state.db.exec(mutation);
					}
				},
			);
			try {
				const response = await handleJmapRequest(jmapSubmissionRequest(sample));
				expect(copied).toBe(true);
				expect(response.status).toBe(name === "key-revoked" ? 401 : 200);
				if (name === "key-revoked")
					expect(await response.json()).toEqual({ error: "Unauthorized" });
				else {
					const body = await response.json();
					expect(body.methodResponses[0][1].notCreated.submission.type).toBe(
						"forbidden",
					);
				}
				expect(
					state.db.query("SELECT id,status,text_body FROM messages").all(),
				).toEqual([
					{
						id: "draft",
						status: "draft",
						text_body: name === "newer-draft" ? "Newer edit" : "Before",
					},
				]);
				expect(state.db.query("SELECT id FROM outbound_jobs").all()).toEqual(
					[],
				);
				expect(
					state.db.query("SELECT * FROM mailrun_submission_drafts").all(),
				).toEqual([]);
				const keys = await Array.fromAsync(
					new Bun.Glob("**/*").scan({
						cwd: state.directory + "/blobs",
						onlyFiles: true,
					}),
				);
				expect(keys).toEqual(["stored.txt"]);
			} finally {
				put.mockRestore();
			}
		},
	);
async function queuedSubmission() {
	await prepareJmapSubmission(state.db, state.directory, { name: "recovery" });
	return queueSourceSend(
		owner,
		{
			mailboxId: "mailbox",
			from: "hello@example.com",
			to: "maya@example.net",
			subject: "Recovery",
			text: "Approved body",
		},
		[],
		JMAP_SUBMISSION_ORIGIN,
		undefined,
		undefined,
		async (sql, publication) => {
			await sql.ReserveSourceJmapDraft`INSERT INTO mailrun_submission_drafts(job_id,draft_id,draft_revision) VALUES(${publication.jobId},${"draft"},${0})`;
		},
	);
}
test("a committed send with audit evidence finishes draft cleanup after loss of its HTTP process without transport replay", async () => {
	const queued = await queuedSubmission();
	state.db
		.query("UPDATE outbound_jobs SET status='sent' WHERE id=?")
		.run(queued.jobId);
	state.db
		.query(
			"UPDATE messages SET status='sent',provider_message_id='<ack@example.net>' WHERE id=?",
		)
		.run(queued.messageId);
	state.db
		.query(
			"INSERT INTO audit_logs(id,actor_user_id,mailbox_id,message_id,action,created_at) VALUES('completed','owner','mailbox',?,'email.send',1)",
		)
		.run(queued.messageId);
	expect((await runJob("scheduled")).skipped).toBe(false);
	expect(
		state.db.query("SELECT id FROM messages WHERE id='draft'").get(),
	).toBeNull();
	expect(await new LocalStorage().file("stored.txt").exists()).toBe(false);
	expect(
		state.db.query("SELECT * FROM mailrun_submission_drafts").all(),
	).toEqual([]);
	await runJob("scheduled");
	expect(state.db.query("SELECT id,status FROM outbound_jobs").all()).toEqual([
		{ id: queued.jobId, status: "sent" },
	]);
});
test("acknowledgement without completed audit evidence retains the draft and its durable reservation", async () => {
	const queued = await queuedSubmission();
	state.db
		.query("UPDATE outbound_jobs SET status='sent' WHERE id=?")
		.run(queued.jobId);
	expect(await cleanupSubmittedDraft(queued.jobId)).toBe(false);
	expect(
		state.db.query("SELECT draft_id FROM mailrun_submission_drafts").all(),
	).toEqual([{ draft_id: "draft" }]);
	expect(
		state.db.query("SELECT status FROM messages WHERE id='draft'").get(),
	).toEqual({ status: "draft" });
});
test("cleanup protects newer draft revisions even when they came from a writer bypassing the active reservation", async () => {
	const queued = await queuedSubmission();
	state.db
		.query("UPDATE outbound_jobs SET status='sent' WHERE id=?")
		.run(queued.jobId);
	state.db
		.query(
			"INSERT INTO audit_logs(id,actor_user_id,mailbox_id,message_id,action,created_at) VALUES('completed','owner','mailbox',?,'email.send',1)",
		)
		.run(queued.messageId);
	state.db.exec(
		"UPDATE messages SET draft_revision=1,text_body='Newer edit' WHERE id='draft'",
	);
	expect(await cleanupSubmittedDraft(queued.jobId)).toBe(true);
	expect(
		state.db.query("SELECT text_body FROM messages WHERE id='draft'").get(),
	).toEqual({ text_body: "Newer edit" });
	expect(await new LocalStorage().file("stored.txt").exists()).toBe(true);
});
test("successful cleanup retains objects still referenced by another message", async () => {
	const queued = await queuedSubmission();
	state.db
		.query("UPDATE outbound_jobs SET status='sent' WHERE id=?")
		.run(queued.jobId);
	state.db
		.query(
			"INSERT INTO audit_logs(id,actor_user_id,mailbox_id,message_id,action,created_at) VALUES('completed','owner','mailbox',?,'email.send',1)",
		)
		.run(queued.messageId);
	state.db.exec(
		"INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,raw_r2_key,created_at) VALUES('other','owner','mailbox','inbound','sender@example.net','hello@example.com','received','stored.txt',1)",
	);
	expect(await cleanupSubmittedDraft(queued.jobId)).toBe(true);
	expect(await new LocalStorage().file("stored.txt").exists()).toBe(true);
	expect(
		state.db.query("SELECT id FROM messages WHERE id='draft'").get(),
	).toBeNull();
});
test("recovery releases an abandoned post-ack reservation after its lease without deleting the draft or replaying delivery", async () => {
	const queued = await queuedSubmission();
	state.db
		.query("UPDATE outbound_jobs SET status='sent',updated_at=1 WHERE id=?")
		.run(queued.jobId);
	state.db.exec(
		"INSERT INTO mailrun_job_leases(name,owner,expires_at) VALUES('draft:draft','active',9999999999)",
	);
	await runJob("scheduled");
	expect(
		state.db.query("SELECT draft_id FROM mailrun_submission_drafts").all(),
	).toEqual([{ draft_id: "draft" }]);
	state.db.exec("DELETE FROM mailrun_job_leases WHERE name='draft:draft'");
	await runJob("scheduled");
	expect(
		state.db.query("SELECT * FROM mailrun_submission_drafts").all(),
	).toEqual([]);
	expect(
		state.db.query("SELECT status FROM messages WHERE id='draft'").get(),
	).toEqual({ status: "draft" });
	expect(await new LocalStorage().file("stored.txt").exists()).toBe(true);
	expect(
		state.db
			.query("SELECT status FROM outbound_jobs WHERE id=?")
			.get(queued.jobId),
	).toEqual({ status: "sent" });
});
for (const scope of [undefined, "all"] as const)
	test(
		"unknown legacy grants retain metadata but deny draft bodies and files with scope " +
			(scope ?? "explicit"),
		async () => {
			const sample = {
				name: "unknown-body-denial",
				actor: "stranger" as const,
				permission: "unknown",
				scope,
			};
			await prepareJmapSubmission(state.db, state.directory, sample);
			const request = jmapSubmissionRequest({
				...sample,
				method: "Email/get",
				args: { ids: ["draft"], properties: ["textBody", "bodyValues"] },
			});
			const response = await handleJmapRequest(request),
				body = await response.json();
			expect(body.methodResponses[0][1].list).toEqual([]);
			expect(body.methodResponses[0][1].notFound).toEqual(["draft"]);
			const file = await handleJmapRequest(
				new Request(
					JMAP_SUBMISSION_ORIGIN +
						"/jmap/download/stranger/att~stored-file/file",
					{ headers: request.headers },
				),
			);
			expect(file.status).toBe(404);
			await file.body?.cancel();
		},
	);
