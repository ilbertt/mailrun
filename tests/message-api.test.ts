import { test, expect, beforeEach, afterEach } from "bun:test";
import { fixture, owner, stranger, enableTeamSharing } from "./fixtures";
import { queryMessages } from "../src/server/mail/message-query";
import {
	bulkAction,
	snooze,
	toggleStar,
} from "../src/server/mail/message-actions";
import { dispatchMailApi } from "../src/server/api/mail";
import { LocalStorage } from "../src/server/storage";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
test("the original list contract groups before pagination and returns exact totals on empty deep pages", async () => {
	state.db.exec("UPDATE messages SET thread_id='thread' WHERE id='message'");
	const insert = state.db.query(
		"INSERT INTO messages (id,user_id,mailbox_id,direction,from_addr,to_addr,subject,status,thread_id,created_at) VALUES (?,'owner','mailbox','inbound','sender@example.org','hello@example.com',?,'received',?,?)",
	);
	insert.run("reply", "Reply", "thread", 2);
	const grouped = await queryMessages(owner, {
		mailboxId: "mailbox",
		status: "received",
		group: "thread",
		limit: 25,
	});
	expect(grouped.total).toBe(1);
	expect(grouped.messages[0]?.id).toBe("reply");
	expect(grouped.messages[0]?.threadCount).toBe(2);
	expect(grouped.messages[0]?.threadUnread).toBe(2);
	expect(grouped.messages[0]?.threadMessageIds?.sort()).toEqual([
		"message",
		"reply",
	]);
	expect(grouped.messages[0]).not.toHaveProperty("htmlBody");
	for (let index = 0; index < 27; index++)
		insert.run(
			`row-${index}`,
			`Subject ${index}`,
			`thread-${index}`,
			10 + index,
		);
	const first = await queryMessages(owner, {
		mailboxId: "mailbox",
		status: "received",
		group: "thread",
		limit: 25,
	});
	expect(first.total).toBe(28);
	expect(first.messages).toHaveLength(25);
	const next = await queryMessages(owner, {
		mailboxId: "mailbox",
		status: "received",
		group: "thread",
		limit: 25,
		offset: 25,
	});
	expect(next.messages).toHaveLength(3);
	expect(
		new Set([...first.messages, ...next.messages].map((message) => message.id))
			.size,
	).toBe(28);
	const empty = await queryMessages(owner, {
		mailboxId: "mailbox",
		status: "received",
		group: "thread",
		limit: 25,
		offset: 100,
	});
	expect(empty.total).toBe(28);
	expect(empty.messages).toEqual([]);
});
test("Gmail search operators, phrases, exclusions and dates remain bound data", async () => {
	state.db
		.query(
			"INSERT INTO messages (id,user_id,mailbox_id,direction,from_addr,to_addr,subject,text_body,status,created_at) VALUES ('invoice','owner','mailbox','inbound','Maya <maya@acme.test>','hello@example.com','Invoice September','An exact phrase in the invoice','received',?)",
		)
		.run(Date.parse("2026-09-15T12:00:00Z") / 1000);
	state.db.exec(
		"INSERT INTO message_attachments (id,message_id,filename,content_type,size,r2_key,created_at) VALUES ('file','invoice','report.pdf','application/pdf',1,'invoice.pdf',1)",
	);
	const result = await queryMessages(owner, {
		mailboxId: "mailbox",
		q: 'from:maya subject:inv has:attachment after:2026-09-01 before:2026-10-01 "exact phrase" -draft',
	});
	expect(result.messages.map((message) => message.id)).toEqual(["invoice"]);
	expect(
		(
			await queryMessages(owner, { mailboxId: "mailbox", q: "-invoice" })
		).messages.map((message) => message.id),
	).toEqual(["message"]);
	expect(
		(await queryMessages(owner, { mailboxId: "mailbox", q: '" OR 1=1 --' }))
			.messages,
	).toEqual([]);
});
test("list and thread APIs never expose private shared drafts or inaccessible mailboxes", async () => {
	enableTeamSharing(state.db);
	state.db.exec(
		"INSERT INTO mailbox_access (id,mailbox_id,user_id,permission,created_at) VALUES ('share','mailbox','stranger','read_only',1); INSERT INTO messages (id,user_id,mailbox_id,direction,from_addr,to_addr,subject,status,thread_id,created_at) VALUES ('draft','owner','mailbox','outbound','hello@example.com','maya@example.net','Private','draft','thread',2); UPDATE messages SET thread_id='thread' WHERE id='message'",
	);
	expect(
		(
			await queryMessages(stranger, { mailboxId: "mailbox", group: "thread" })
		).messages.flatMap((message) => message.threadMessageIds ?? []),
	).not.toContain("draft");
	expect(
		(await queryMessages(stranger, { mailboxId: "mailbox", status: "draft" }))
			.messages,
	).toEqual([]);
	const response = await dispatchMailApi(
		new Request("https://mail.example/api/messages/message/thread"),
		stranger,
	);
	const body = await response.json();
	expect(body.messages.map((message: { id: string }) => message.id)).toEqual([
		"message",
	]);
	await expect(
		queryMessages(stranger, { mailboxId: "missing" }),
	).rejects.toMatchObject({ status: 404 });
});
test("read-only shares may mark mail read and star but cannot move or snooze", async () => {
	enableTeamSharing(state.db);
	state.db.exec(
		"INSERT INTO mailbox_access (id,mailbox_id,user_id,permission,created_at) VALUES ('share','mailbox','stranger','read_only',1)",
	);
	await bulkAction(stranger, { messageIds: ["message"], action: "read" });
	expect(
		(await queryMessages(stranger, { mailboxId: "mailbox" })).messages[0]?.read,
	).toBe(true);
	await expect(
		bulkAction(stranger, { messageIds: ["message"], action: "trash" }),
	).rejects.toMatchObject({ status: 404 });
	expect(await toggleStar(stranger, "message")).toEqual({ starred: true });
	await expect(
		snooze(stranger, "message", new Date(Date.now() + 60000).toISOString()),
	).rejects.toMatchObject({ status: 404 });
});
test("permanent deletion skips live mail and removes trashed MIME, files, links and search entries", async () => {
	const storage = new LocalStorage();
	await storage.put("inbound/source.eml", "MIME");
	await storage.put("attachments/source.txt", "File");
	state.db.exec(
		"UPDATE messages SET raw_r2_key='inbound/source.eml' WHERE id='message'; INSERT INTO message_attachments (id,message_id,filename,content_type,size,r2_key,created_at) VALUES ('file','message','source.txt','text/plain',4,'attachments/source.txt',1); INSERT INTO shared_attachment_links (id,attachment_id,expires_at,created_at) VALUES ('link','file',9999999999,1)",
	);
	expect(
		await bulkAction(owner, { messageIds: ["message"], action: "delete" }),
	).toMatchObject({ deleted: 0, skipped: 1 });
	expect(await storage.file("inbound/source.eml").exists()).toBe(true);
	await bulkAction(owner, { messageIds: ["message"], action: "trash" });
	expect(
		await bulkAction(owner, { messageIds: ["message"], action: "delete" }),
	).toMatchObject({ deleted: 1, skipped: 0 });
	expect(await storage.file("inbound/source.eml").exists()).toBe(false);
	expect(await storage.file("attachments/source.txt").exists()).toBe(false);
	expect(
		state.db.query("SELECT id FROM shared_attachment_links").all(),
	).toEqual([]);
	expect((await queryMessages(owner, { q: "searchable" })).messages).toEqual(
		[],
	);
	expect(
		state.db
			.query(
				"SELECT action FROM audit_logs WHERE json_extract(metadata,'$.permanent')=1",
			)
			.all(),
	).toEqual([{ action: "email.delete" }]);
});
test("snoozed mail leaves the inbox until due, and star toggles are atomic", async () => {
	await snooze(owner, "message", new Date(Date.now() + 60000).toISOString());
	expect((await queryMessages(owner, { status: "received" })).messages).toEqual(
		[],
	);
	expect(
		(await queryMessages(owner, { snoozed: "true" })).messages[0]?.id,
	).toBe("message");
	await snooze(owner, "message", null);
	expect(
		(await queryMessages(owner, { status: "received" })).messages,
	).toHaveLength(1);
	expect(await toggleStar(owner, "message")).toEqual({ starred: true });
	expect(await toggleStar(owner, "message")).toEqual({ starred: false });
});
