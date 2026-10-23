import { test, expect, beforeEach, afterEach } from "bun:test";
import { fixture, owner, stranger } from "./fixtures";
import {
	saveDraft,
	getDraft,
	uploadAttachments,
	removeAttachment,
	deleteDraft,
} from "../src/server/mail/drafts";
import {
	listMessages,
	getThread,
	mailCounts,
	changeMessage,
} from "../src/server/mail/repository";
import { sendDraft, deliverJob } from "../src/server/mail/send";
import { sharedFile } from "../src/server/mail/attachment-send";
import { LocalStorage } from "../src/server/storage";
import { z } from "zod";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
const input = {
	mailboxId: "mailbox",
	to: "Maya <maya@example.net>",
	cc: "",
	bcc: "",
	subject: "Draft subject",
	html: "<p>Hello</p>",
	text: "Hello",
};
test("drafts survive save/reopen; stale revisions and shared readers cannot overwrite or inspect them", async () => {
	const draft = await saveDraft(owner, input);
	const saved = await saveDraft(owner, {
		...input,
		id: draft.id,
		revision: draft.draft_revision,
		subject: "Updated",
	});
	expect((await getDraft(owner, draft.id)).subject).toBe("Updated");
	await expect(
		saveDraft(owner, {
			...input,
			id: draft.id,
			revision: draft.draft_revision,
		}),
	).rejects.toThrow("another tab");
	state.db.exec(
		"INSERT INTO mailbox_access (id,mailbox_id,user_id,permission,created_at) VALUES ('share','mailbox','stranger','full_access',1)",
	);
	await expect(getDraft(stranger, draft.id)).rejects.toThrow("not found");
	expect(
		(
			await listMessages(stranger, {
				folder: "drafts",
				mailboxId: "mailbox",
				q: "",
				offset: 0,
			})
		).messages,
	).toHaveLength(0);
	expect(saved.draft_revision).toBe(1);
});
test("draft attachments are persisted, removed and cleaned up on discard", async () => {
	const draft = await saveDraft(owner, input);
	const uploaded = await uploadAttachments(owner, draft.id, [
		new File(["hello"], "note.txt", { type: "text/plain" }),
	]);
	const file = uploaded.attachments[0];
	if (!file) throw new Error("Missing file");
	expect(await new LocalStorage().file(file.r2_key).text()).toBe("hello");
	await expect(
		uploadAttachments(stranger, draft.id, [new File(["bad"], "bad.txt")]),
	).rejects.toThrow("not found");
	expect(
		(await removeAttachment(owner, draft.id, file.id)).attachments,
	).toHaveLength(0);
	expect(await new LocalStorage().file(file.r2_key).exists()).toBe(false);
	const second = await uploadAttachments(owner, draft.id, [
		new File(["second"], "second.txt"),
	]);
	await deleteDraft(owner, draft.id);
	expect(
		await new LocalStorage().file(second.attachments[0]!.r2_key).exists(),
	).toBe(false);
	await expect(getDraft(owner, draft.id)).rejects.toThrow();
});
test("forward copies use independent object keys and require source read permission", async () => {
	await new LocalStorage().put("source.txt", "original");
	state.db.exec(
		"INSERT INTO message_attachments (id,message_id,filename,content_type,size,r2_key,created_at) VALUES ('source','message','source.txt','text/plain',8,'source.txt',1)",
	);
	const draft = await saveDraft(owner, {
		...input,
		forwardOfMessageId: "message",
	});
	const file = draft.attachments[0];
	if (!file) throw new Error("Missing copied attachment");
	expect(file.r2_key).not.toBe("source.txt");
	await new LocalStorage().delete("source.txt");
	expect(await new LocalStorage().file(file.r2_key).text()).toBe("original");
	await expect(
		saveDraft(stranger, { ...input, forwardOfMessageId: "message" }),
	).rejects.toThrow();
});
test("attachment limits fail before any metadata is added", async () => {
	const draft = await saveDraft(owner, input);
	await expect(
		uploadAttachments(
			owner,
			draft.id,
			Array.from({ length: 11 }, (_, i) => new File(["a"], `${i}.txt`)),
		),
	).rejects.toThrow("limit");
	expect((await getDraft(owner, draft.id)).attachments).toHaveLength(0);
});
function install() {
	state.db.exec(
		"INSERT INTO mailrun_installation VALUES ('primary','account','zone','example.com','relay','https://mail.example.com','token','secret','v1','ready',1)",
	);
}
const sentSchema = z.object({
	to: z.array(z.string()),
	cc: z.array(z.string()).optional(),
	bcc: z.array(z.string()).optional(),
	headers: z.record(z.string(), z.string()),
	attachments: z.array(z.object({ filename: z.string(), content: z.string() })),
	text: z.string(),
	html: z.string(),
});
test("send snapshots recipients, reply headers and base64 attachments", async () => {
	install();
	let payload: unknown;
	const draft = await saveDraft(owner, {
		...input,
		cc: "Copy <copy@example.net>",
		bcc: "hidden@example.net",
		inReplyTo: "source@example.org",
		references: "<source@example.org>",
	});
	const uploaded = await uploadAttachments(owner, draft.id, [
		new File(["hello"], "note.txt", { type: "text/plain" }),
	]);
	await sendDraft(
		owner,
		draft.id,
		uploaded.draft_revision,
		async (_url, init) => {
			payload = JSON.parse(String(init?.body));
			return Response.json({
				success: true,
				result: { message_id: "<sent@example.com>" },
			});
		},
	);
	const sent = sentSchema.parse(payload);
	expect(sent.to).toEqual(["Maya <maya@example.net>"]);
	expect(sent.bcc).toEqual(["hidden@example.net"]);
	expect(sent.headers["In-Reply-To"]).toBe("<source@example.org>");
	expect(sent.attachments[0]?.content).toBe("aGVsbG8=");
	expect(
		state.db.query("SELECT status FROM messages WHERE id=?").get(draft.id),
	).toEqual({ status: "sent" });
});
test("failed delivery leaves an editable draft and its attachments", async () => {
	install();
	const draft = await saveDraft(owner, input);
	const withFiles = await uploadAttachments(owner, draft.id, [
		new File(["hello"], "note.txt"),
	]);
	await expect(
		sendDraft(owner, draft.id, withFiles.draft_revision, async () =>
			Response.json(
				{
					success: false,
					result: {},
					errors: [{ message: "Provider rejected" }],
				},
				{ status: 400 },
			),
		),
	).rejects.toThrow("Provider rejected");
	expect((await getDraft(owner, draft.id)).attachments).toHaveLength(1);
});
test("scheduled attachments remain immutable until nibrun delivers them", async () => {
	install();
	const draft = await saveDraft(owner, {
		...input,
		scheduledAt: new Date(Date.now() + 60000).toISOString(),
	});
	const files = await uploadAttachments(owner, draft.id, [
		new File(["hello"], "note.txt"),
	]);
	let calls = 0;
	expect(
		(
			await sendDraft(owner, draft.id, files.draft_revision, async () => {
				calls++;
				throw new Error("Too early");
			})
		).scheduled,
	).toBe(true);
	expect(calls).toBe(0);
	await expect(
		uploadAttachments(owner, draft.id, [new File(["bad"], "bad.txt")]),
	).rejects.toThrow();
	const job = z
		.object({ id: z.string() })
		.parse(
			state.db
				.query("SELECT id FROM outbound_jobs WHERE message_id=?")
				.get(draft.id),
		);
	state.db
		.query("UPDATE outbound_jobs SET scheduled_at=0 WHERE id=?")
		.run(job.id);
	await deliverJob(job.id, async () =>
		Response.json({
			success: true,
			result: { message_id: "<scheduled@example.com>" },
		}),
	);
	expect(
		state.db.query("SELECT status FROM messages WHERE id=?").get(draft.id),
	).toEqual({ status: "sent" });
});
test("large files become expiring local links instead of oversized provider payloads", async () => {
	install();
	let payload: unknown;
	const draft = await saveDraft(owner, input);
	const files = await uploadAttachments(owner, draft.id, [
		new File([new Uint8Array(3_000_001)], "large<file>.bin"),
	]);
	await sendDraft(owner, draft.id, files.draft_revision, async (_url, init) => {
		payload = JSON.parse(String(init?.body));
		return Response.json({
			success: true,
			result: { message_id: "<large@example.com>" },
		});
	});
	const sent = sentSchema.parse(payload);
	expect(sent.attachments).toHaveLength(0);
	expect(sent.html).toContain("large&lt;file&gt;.bin");
	const link = z
		.object({ id: z.string() })
		.parse(state.db.query("SELECT id FROM shared_attachment_links").get());
	expect((await sharedFile(link.id)).status).toBe(200);
	state.db.exec("UPDATE shared_attachment_links SET expires_at=0");
	expect((await sharedFile(link.id)).status).toBe(404);
});

test("unconfigured sending preserves a draft; thread reads and counts keep drafts private", async () => {
	const draft = await saveDraft(owner, { ...input, threadId: "shared-thread" });
	await expect(
		sendDraft(owner, draft.id, draft.draft_revision),
	).rejects.toThrow("not configured");
	expect((await getDraft(owner, draft.id)).status).toBe("draft");
	state.db.exec(
		"UPDATE messages SET thread_id='shared-thread' WHERE id='message'; INSERT INTO mailbox_access (id,mailbox_id,user_id,permission,created_at) VALUES ('share','mailbox','stranger','full_access',1)",
	);
	expect((await getThread(stranger, "message")).map((row) => row.id)).toEqual([
		"message",
	]);
	expect((await mailCounts(stranger, "mailbox")).drafts).toBe(0);
	expect((await mailCounts(owner, "mailbox")).drafts).toBe(1);
});
test("header injection is rejected before a draft is persisted", async () => {
	await expect(
		saveDraft(owner, { ...input, subject: "Hello\r\nBcc: hidden@example.com" }),
	).rejects.toThrow("Invalid email header");
});

test("trashing a scheduled message cancels its pending job", async () => {
	install();
	const draft = await saveDraft(owner, {
		...input,
		scheduledAt: new Date(Date.now() + 60000).toISOString(),
	});
	await sendDraft(owner, draft.id, draft.draft_revision);
	await changeMessage(owner, { id: draft.id, action: "trash" });
	expect(
		state.db
			.query("SELECT status FROM outbound_jobs WHERE message_id=?")
			.get(draft.id),
	).toEqual({ status: "cancelled" });
});
test("scheduled delivery rechecks alias access and restores the draft when revoked", async () => {
	install();
	state.db.exec(
		"INSERT INTO mailbox_aliases (id,mailbox_id,domain_id,local_part,created_at) VALUES ('alias','mailbox','domain','support',1)",
	);
	const draft = await saveDraft(owner, {
		...input,
		from: "support@example.com",
		scheduledAt: new Date(Date.now() + 60000).toISOString(),
	});
	await sendDraft(owner, draft.id, draft.draft_revision);
	const job = z
		.object({ id: z.string() })
		.parse(
			state.db
				.query("SELECT id FROM outbound_jobs WHERE message_id=?")
				.get(draft.id),
		);
	state.db.exec(
		"DELETE FROM mailbox_aliases WHERE id='alias'; UPDATE outbound_jobs SET scheduled_at=0",
	);
	let calls = 0;
	await expect(
		deliverJob(job.id, async () => {
			calls++;
			throw new Error("Should not send");
		}),
	).rejects.toThrow("not assigned");
	expect(calls).toBe(0);
	expect((await getDraft(owner, draft.id)).status).toBe("draft");
});
