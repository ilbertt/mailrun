import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { fixture, owner, stranger } from "./fixtures";
import { listMessages, getThread, changeMessage, messageFile } from "../src/server/mail/repository";
import { storeInbound, inbound } from "../src/server/mail/inbound";
import { LocalStorage } from "../src/server/storage";
import { signRelay } from "../src/shared/relay-signature";

let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => { state = await fixture(); });
afterEach(async () => { await state.close(); });
describe("mailbox access and SQL", () => {
	test("lists and searches authorized mail only", async () => {
		expect((await listMessages(owner, { folder: "inbox", q: "searchable", offset: 0 })).messages.map(row => row.id)).toEqual(["message"]);
		await expect(listMessages(stranger, { folder: "inbox", mailboxId: "mailbox", q: "", offset: 0 })).rejects.toThrow("Mailbox not found");
		await expect(getThread(stranger, "message")).rejects.toThrow("Message not found");
		await expect(messageFile(stranger, "message")).rejects.toThrow("Message not found");
	});
	test("read-only shared access cannot mutate messages", async () => {
		state.db.query("INSERT INTO mailbox_access (id,mailbox_id,user_id,permission,created_at) VALUES ('access','mailbox','stranger','read_only',1)").run();
		expect((await getThread(stranger, "message")).length).toBe(1);
		await expect(changeMessage(stranger, { id: "message", action: "trash" })).rejects.toThrow("not permitted");
		await changeMessage(owner, { id: "message", action: "archive" });
		expect((await listMessages(owner, { folder: "archived", q: "", offset: 0 })).messages.length).toBe(1);
	});
	test("FTS punctuation is data, not SQL or FTS syntax", async () => {
		const result = await listMessages(owner, { folder: "inbox", q: `" OR 1=1 --`, offset: 0 });
		expect(result.messages).toEqual([]);
	});
});
describe("local inbound mail", () => {
	test("persists raw MIME, searchable body and a local attachment exactly once", async () => {
		const raw = new TextEncoder().encode([
			"From: sender@example.org", "To: hello@example.com", "Subject: Attachment delivery", "Message-ID: <fixture@example.org>",
			"MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="boundary"', "",
			"--boundary", "Content-Type: text/plain", "", "A new local message",
			"--boundary", 'Content-Type: text/plain; name="note.txt"', 'Content-Disposition: attachment; filename="note.txt"',
			"Content-Transfer-Encoding: base64", "", "aGVsbG8=", "--boundary--", "",
		].join("\r\n"));
		const [result, duplicate] = await Promise.all([
			storeInbound("sender@example.org", "hello@example.com", raw),
			storeInbound("sender@example.org", "hello@example.com", raw),
		]);
		if (!result) throw new Error("Missing inbound result");
		expect(result.action).toBe("store");
		expect(duplicate).toEqual(result);
		expect(await storeInbound("sender@example.org", "hello@example.com", raw)).toEqual(result);
		const attachments = state.db.query<{ r2_key: string }, []>("SELECT r2_key FROM message_attachments").all();
		expect(attachments).toHaveLength(1);
		expect(await new LocalStorage().file(attachments[0]!.r2_key).text()).toBe("hello");
		expect((await listMessages(owner, { folder: "inbox", q: "local", offset: 0 })).messages).toHaveLength(1);
	});
	test("requires a valid signed relay request", async () => {
		state.db.query("INSERT INTO mailrun_installation VALUES ('primary','account','zone','example.com','relay','https://mail.example.com','token','secret','v1','ready',1)").run();
		const raw = new TextEncoder().encode("Subject: Signed\r\n\r\nA signed email");
		const timestamp = String(Date.now());
		const headers = { "x-mailrun-from": "sender@example.org", "x-mailrun-to": "hello@example.com", "x-mailrun-timestamp": timestamp, "x-mailrun-signature": await signRelay("secret", timestamp, "sender@example.org", "hello@example.com", raw) };
		expect((await inbound(new Request("http://localhost/api/inbound", { method: "POST", headers, body: raw }))).status).toBe(200);
		expect((await inbound(new Request("http://localhost/api/inbound", { method: "POST", headers: { ...headers, "x-mailrun-to": "other@example.com" }, body: raw }))).status).toBe(401);
	});
	test("rejects path traversal in local object keys", () => {
		const storage = new LocalStorage();
		expect(() => storage.file("../secret")).toThrow("Invalid object key");
		expect(() => storage.file("/etc/passwd")).toThrow("Invalid object key");
	});
});
