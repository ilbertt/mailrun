import { test, expect, beforeEach, afterEach } from "bun:test";
import { fixture, owner } from "./fixtures";
import { storeInbound } from "../src/server/mail/inbound";
import { queryMessages } from "../src/server/mail/message-query";
import { dispatchMailApi } from "../src/server/api/mail";
import { queueAutoReply } from "../src/server/mail/auto-reply";
import { deliverJob } from "../src/server/mail/send";
import { runTrashRetention } from "../src/server/jobs/retention";
import { bulkAction } from "../src/server/mail/message-actions";
import { LocalStorage } from "../src/server/storage";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
const mime = (headers: string[], body: string) =>
	new TextEncoder().encode([...headers, "", body].join("\r\n"));
test("incoming References restore the original thread and snippets discard quoted history", async () => {
	state.db.exec(
		"UPDATE messages SET thread_id='original-thread',provider_message_id='<root@example.net>' WHERE id='message'",
	);
	const result = await storeInbound(
		"maya@example.net",
		"hello@example.com",
		mime(
			[
				"From: Maya <maya@example.net>",
				"To: hello@example.com",
				"Subject: Re: Project",
				"Message-ID: <reply@example.net>",
				"In-Reply-To: <missing@example.net>",
				"References: <root@example.net> <missing@example.net>",
				"Content-Type: text/plain",
			],
			"Latest answer\r\n\r\nOn Monday, Owner wrote:\r\n> Older message",
		),
	);
	if (result.action !== "store") throw new Error("Expected stored message");
	const row = state.db
		.query<
			{ thread_id: string; snippet: string; in_reply_to: string },
			[string]
		>("SELECT thread_id,snippet,in_reply_to FROM messages WHERE id=?")
		.get(result.messageId);
	expect(row?.thread_id).toBe("original-thread");
	expect(row?.snippet).toBe("Latest answer");
	expect(row?.in_reply_to).toBe("missing@example.net");
	expect(
		state.db
			.query(
				"SELECT display_name,source FROM contacts WHERE email='maya@example.net'",
			)
			.get(),
	).toEqual({ display_name: "Maya", source: "inbound" });
});
test("the original local spam classifier honors blocked contacts and the account preference", async () => {
	state.db.exec(
		"INSERT INTO contacts (id,user_id,email,source,blocked,created_at) VALUES ('blocked','owner','blocked@example.net','manual',1,1)",
	);
	const first = await storeInbound(
		"blocked@example.net",
		"hello@example.com",
		mime(
			[
				"From: blocked@example.net",
				"Message-ID: <blocked@example.net>",
				"Subject: Test",
			],
			"A blocked message",
		),
	);
	if (first.action !== "store") throw new Error("Expected stored message");
	expect(
		state.db
			.query("SELECT status,spam_score,spam_verdict FROM messages WHERE id=?")
			.get(first.messageId),
	).toEqual({ status: "spam", spam_score: 100, spam_verdict: "spam" });
	state.db.exec("UPDATE users SET spam_protection_enabled=0 WHERE id='owner'");
	const second = await storeInbound(
		"blocked@example.net",
		"hello@example.com",
		mime(
			[
				"From: blocked@example.net",
				"Message-ID: <allowed@example.net>",
				"Subject: Test",
			],
			"A second message",
		),
	);
	if (second.action !== "store") throw new Error("Expected stored message");
	expect(
		state.db
			.query("SELECT status,spam_score FROM messages WHERE id=?")
			.get(second.messageId),
	).toEqual({ status: "received", spam_score: null });
});
test("auto replies suppress loops, share one pending job, and throttle only after a successful send", async () => {
	state.db.exec(
		"UPDATE mailboxes SET auto_reply_enabled=1,auto_reply_body='Back tomorrow' WHERE id='mailbox';INSERT INTO mailrun_installation VALUES ('primary','account','zone','example.com','relay','https://mail.example.com','token','secret','v1','ready',1)",
	);
	const input = {
		mailboxId: "mailbox",
		userId: "owner",
		deliveredAddress: "hello@example.com",
		fromAddress: "Maya <maya@example.net>",
		incomingMessageId: "<incoming@example.net>",
		threadId: "thread",
		headers: {},
	};
	expect(
		await queueAutoReply({
			...input,
			headers: { "auto-submitted": "auto-replied" },
		}),
	).toBeNull();
	expect(
		await queueAutoReply({ ...input, headers: { "list-id": "list.example" } }),
	).toBeNull();
	const [first, duplicate] = await Promise.all([
		queueAutoReply(input),
		queueAutoReply(input),
	]);
	expect([first, duplicate].filter(Boolean)).toHaveLength(1);
	const job = first ?? duplicate;
	if (!job) throw new Error("Missing job");
	let headers: Record<string, string> | undefined;
	await deliverJob(job, async (_url, init) => {
		headers = JSON.parse(String(init?.body)).headers;
		return Response.json({
			success: true,
			result: { message_id: "auto@example.com" },
		});
	});
	expect(headers).toMatchObject({
		"Auto-Submitted": "auto-replied",
		"X-Auto-Response-Suppress": "All",
		"In-Reply-To": "<incoming@example.net>",
	});
	expect(headers).not.toHaveProperty("Message-ID");
	expect(await queueAutoReply(input)).toBeNull();
	expect(
		state.db.query("SELECT count(*) AS total FROM auto_reply_deliveries").get(),
	).toEqual({ total: 1 });
});
test("templates stay outside mail lists and retain the original save/apply contract", async () => {
	const saved = await dispatchMailApi(
		new Request("https://mail.example/api/templates", {
			method: "POST",
			body: JSON.stringify({
				mailboxId: "mailbox",
				title: "Welcome template",
				html: "<p>Hello</p>",
				text: "Hello",
			}),
		}),
		owner,
	);
	expect(saved.status).toBe(201);
	const list = await (
		await dispatchMailApi(
			new Request("https://mail.example/api/templates"),
			owner,
		)
	).json();
	expect(list.templates[0]).toMatchObject({
		subject: "Welcome template",
		htmlBody: "<p>Hello</p>",
	});
	expect(
		(await queryMessages(owner, {})).messages.map((message) => message.subject),
	).not.toContain("Welcome template");
});
test("retention respects the owner setting and preserves objects still referenced by another message", async () => {
	const storage = new LocalStorage();
	await storage.put("shared.eml", "Shared MIME");
	await storage.put("expired.eml", "Expired MIME");
	state.db.exec(
		"UPDATE users SET trash_retention_days=7 WHERE id='owner';UPDATE messages SET status='trash',raw_r2_key='shared.eml' WHERE id='message';UPDATE messages SET trashed_at=1 WHERE id='message';INSERT INTO messages (id,user_id,mailbox_id,direction,from_addr,to_addr,status,raw_r2_key,created_at) VALUES ('other','owner','mailbox','inbound','x@example.net','hello@example.com','received','shared.eml',1),('expired','owner','mailbox','inbound','x@example.net','hello@example.com','spam','expired.eml',1);UPDATE messages SET trashed_at=1 WHERE id='expired'",
	);
	expect(await runTrashRetention()).toBe(2);
	expect(await storage.file("shared.eml").exists()).toBe(true);
	expect(await storage.file("expired.eml").exists()).toBe(false);
	expect(state.db.query("SELECT id FROM messages").all()).toEqual([
		{ id: "other" },
	]);
	await bulkAction(owner, { messageIds: ["other"], action: "trash" });
	await bulkAction(owner, { messageIds: ["other"], action: "delete" });
	expect(await storage.file("shared.eml").exists()).toBe(false);
});
