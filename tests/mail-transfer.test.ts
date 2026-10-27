import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { fixture, owner, stranger, enableTeamSharing } from "./fixtures";
import {
	parseImportUpload,
	importMessages,
} from "../src/server/mail-transfer/import";
import { exportMailbox } from "../src/server/mail-transfer/export";
import { splitMboxMessages } from "../src/lib/import/mbox";
import { parseImportDestination } from "../src/lib/import/destination";
import { LocalStorage } from "../src/server/storage";
import { bulkAction } from "../src/server/mail/message-actions";
import { createWebhook } from "../src/server/webhooks/repository";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
const destination = parseImportDestination("system:inbox");
const eml = (messageId = "import@example.org", body = "Imported body") =>
	new TextEncoder().encode(
		`From: Sender <sender@example.org>\r\nTo: hello@example.com\r\nCc: copy@example.org\r\nReply-To: reply@example.org\r\nDate: Wed, 15 Jan 2025 12:34:56 +0000\r\nMessage-ID: <${messageId}>\r\nSubject: Imported message\r\n\r\n${body}`,
	).buffer;
const message = (messageId?: string) => ({
	filename: "mail.eml",
	raw: eml(messageId),
});
test("file import preserves MIME metadata, date, bodies, raw files and contacts without live-mail side effects", async () => {
	await createWebhook(owner, {
		url: "https://hooks.example.org",
		events: ["message.inbound"],
		maxAttempts: 2,
	});
	expect(
		await importMessages(owner, "mailbox", destination, [message()]),
	).toEqual({ imported: 1, skipped: 0, errors: [] });
	const row = state.db
		.query<
			{
				id: string;
				created_at: number;
				from_addr: string;
				cc_addr: string;
				reply_to: string;
				raw_r2_key: string;
				status: string;
				read: number;
			},
			[]
		>("SELECT * FROM messages WHERE provider_message_id='<import@example.org>'")
		.get()!;
	expect(row).toMatchObject({
		created_at: 1736944496,
		from_addr: '"Sender" <sender@example.org>',
		cc_addr: "copy@example.org",
		reply_to: "reply@example.org",
		status: "received",
		read: 0,
	});
	expect(await new LocalStorage().file(row.raw_r2_key).arrayBuffer()).toEqual(
		eml(),
	);
	expect(
		state.db
			.query(
				"SELECT email,source FROM contacts WHERE email='sender@example.org'",
			)
			.get(),
	).toEqual({ email: "sender@example.org", source: "inbound" });
	expect(state.db.query("SELECT id FROM webhook_deliveries").all()).toEqual([]);
	expect(state.db.query("SELECT id FROM outbound_jobs").all()).toEqual([]);
	expect(
		state.db
			.query(
				"SELECT rowid FROM messages_fts WHERE messages_fts MATCH '\"Imported\"'",
			)
			.all(),
	).toHaveLength(1);
	expect(
		await importMessages(owner, "mailbox", destination, [message()]),
	).toEqual({ imported: 0, skipped: 1, errors: [] });
});
test("imports honor destination placement and put shared drafts under the importing account", async () => {
	enableTeamSharing(state.db);
	state.db.exec(
		"INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES('access','mailbox','stranger','full_access',1); INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES('folder','owner','mailbox','Imported',1)",
	);
	for (const section of [
		"inbox",
		"sent",
		"drafts",
		"archived",
		"spam",
		"trash",
		"folder:folder",
	]) {
		const dest = parseImportDestination(section),
			id = `${section}@example.org`;
		expect(
			(await importMessages(stranger, "mailbox", dest, [message(id)])).imported,
		).toBe(1);
		const row = state.db
			.query<
				{
					direction: string;
					status: string;
					user_id: string;
					folder_id: string | null;
					read: number;
				},
				[string]
			>(
				"SELECT direction,status,user_id,folder_id,read FROM messages WHERE provider_message_id=?",
			)
			.get(`<${id}>`)!;
		const outbound = ["sent", "drafts"].includes(section);
		expect(row).toMatchObject({
			direction: outbound ? "outbound" : "inbound",
			user_id: outbound ? "stranger" : "owner",
			status:
				section === "inbox" || section === "folder:folder"
					? "received"
					: section === "drafts"
						? "draft"
						: section,
			read: outbound ? 1 : 0,
			folder_id: section === "folder:folder" ? "folder" : null,
		});
	}
	const ownerExport = await (await exportMailbox(owner, "mailbox")).text();
	expect(ownerExport).not.toContain("drafts@example.org");
	const actorExport = await (await exportMailbox(stranger, "mailbox")).text();
	expect(actorExport).toContain("drafts@example.org");
});
test("only manageable mailboxes can import, readable shares can export, and folder ownership is checked", async () => {
	await expect(
		importMessages(stranger, "mailbox", destination, [message()]),
	).rejects.toMatchObject({ status: 404 });
	enableTeamSharing(state.db);
	state.db.exec(
		"INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES('access','mailbox','stranger','read_only',1)",
	);
	await expect(
		importMessages(stranger, "mailbox", destination, [message()]),
	).rejects.toMatchObject({ status: 404 });
	expect(await (await exportMailbox(stranger, "mailbox")).text()).toContain(
		"A searchable subject",
	);
	await expect(
		importMessages(owner, "mailbox", parseImportDestination("folder:missing"), [
			message(),
		]),
	).rejects.toMatchObject({ status: 404 });
	state.db.exec(
		"DELETE FROM mailbox_access; UPDATE users SET disabled=1 WHERE id='owner'",
	);
	await expect(
		importMessages(owner, "mailbox", destination, [message()]),
	).rejects.toMatchObject({ status: 404 });
});
test("imported threads resolve normalized Message-ID parents and preserve inline attachments", async () => {
	state.db.exec(
		"UPDATE messages SET provider_message_id='<parent@example.org>',thread_id='parent-thread'",
	);
	const raw = new TextEncoder().encode(
		'From: sender@example.org\r\nTo: hello@example.com\r\nMessage-ID: <attached@example.org>\r\nIn-Reply-To: <parent@example.org>\r\nReferences: <parent@example.org>\r\nSubject: Attachment\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="part"\r\n\r\n--part\r\nContent-Type: text/html\r\n\r\n<p>Inline <img src="cid:image-one"></p>\r\n--part\r\nContent-Type: image/png; name="one.png"\r\nContent-Disposition: inline; filename="one.png"\r\nContent-ID: <image-one>\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--part--\r\n',
	).buffer;
	expect(
		(
			await importMessages(owner, "mailbox", destination, [
				{ filename: "attached.eml", raw },
			])
		).imported,
	).toBe(1);
	expect(
		state.db
			.query(
				"SELECT thread_id,in_reply_to FROM messages WHERE provider_message_id='<attached@example.org>'",
			)
			.get(),
	).toEqual({ thread_id: "parent-thread", in_reply_to: "parent@example.org" });
	const attachment = state.db
		.query<
			{
				filename: string;
				disposition: string;
				content_id: string;
				r2_key: string;
			},
			[]
		>("SELECT * FROM message_attachments")
		.get()!;
	expect(attachment).toMatchObject({
		filename: "one.png",
		disposition: "inline",
		content_id: "<image-one>",
	});
	expect(await new LocalStorage().file(attachment.r2_key).text()).toBe("hello");
});
test("failed file publication does not commit a partial message and the next file can still import", async () => {
	const original = LocalStorage.prototype.put;
	let called = 0;
	const mock = spyOn(LocalStorage.prototype, "put").mockImplementation(
		async function (this: LocalStorage, key, bytes) {
			if (++called === 1) throw new Error("Disk full");
			return original.call(this, key, bytes);
		},
	);
	try {
		const result = await importMessages(owner, "mailbox", destination, [
			message("first@example.org"),
			message("second@example.org"),
		]);
		expect(result).toMatchObject({ imported: 1, skipped: 1 });
		expect(result.errors[0]).toContain("Disk full");
		expect(
			state.db
				.query(
					"SELECT id FROM messages WHERE provider_message_id='<first@example.org>'",
				)
				.all(),
		).toEqual([]);
	} finally {
		mock.mockRestore();
	}
});
test("concurrent imports deduplicate inside the write transaction and clean staged duplicate objects", async () => {
	const results = await Promise.all([
		importMessages(owner, "mailbox", destination, [message()]),
		importMessages(owner, "mailbox", destination, [message()]),
	]);
	expect(results.map((row) => row.imported).sort()).toEqual([0, 1]);
	expect(
		state.db
			.query(
				"SELECT id FROM messages WHERE provider_message_id='<import@example.org>'",
			)
			.all(),
	).toHaveLength(1);
	const all = await Array.fromAsync(
		new Bun.Glob("imports/*.eml").scan({ cwd: new LocalStorage().root }),
	);
	expect(all).toHaveLength(1);
});
test("upload parsing accepts EML/MBOX/MBX, defaults to Inbox and stops at the source 100-message limit", async () => {
	const form = new FormData();
	form.set("mailboxId", "mailbox");
	form.append(
		"files",
		new File([eml("one@example.org")], "one.eml", { type: "message/rfc822" }),
	);
	const mbox = Array.from(
		{ length: 110 },
		(_, i) =>
			`From MAILER-DAEMON Mon Jan 01 00:00:00 2024\r\nMessage-ID: <bulk-${i}@example.org>\r\nSubject: Bulk ${i}\r\n\r\nBody\r\n\r\n`,
	).join("");
	form.append(
		"files",
		new File([mbox], "bulk.mbx", { type: "application/mbox" }),
	);
	const upload = await parseImportUpload(
		new Request("http://localhost/api/import/messages", {
			method: "POST",
			body: form,
		}),
	);
	expect(upload.messages).toHaveLength(100);
	expect(upload.destination).toEqual(destination);
	expect(upload.messages[1]?.filename).toBe("bulk.mbx#1");
	const huge = new Request("http://localhost/api/import/messages", {
		method: "POST",
		headers: { "Content-Length": String(26 * 1024 * 1024) },
		body: "small",
	});
	await expect(parseImportUpload(huge)).rejects.toThrow("Message too large");
});
test("MBOX exports reproduce the original headers, ordering and From escaping and can be reimported", async () => {
	state.db.exec(
		"UPDATE messages SET text_body='First line'||char(10)||'From body line',provider_message_id='<one@example.org>',in_reply_to='parent@example.org',references_header='root@example.org parent@example.org',cc_addr='copy@example.org'",
	);
	const response = await exportMailbox(owner, "mailbox"),
		mbox = await response.text();
	expect(response.headers.get("content-type")).toContain("application/mbox");
	expect(response.headers.get("content-disposition")).toBe(
		'attachment; filename="hello.mbox"',
	);
	expect(mbox).toContain("In-Reply-To: <parent@example.org>");
	expect(mbox).toContain("References: <root@example.org> <parent@example.org>");
	expect(mbox).toContain("\n>From body line");
	const parts = splitMboxMessages(mbox);
	expect(parts).toHaveLength(1);
	expect(parts[0]).toContain("\nFrom body line");
	state.db.exec("DELETE FROM messages");
	expect(
		await importMessages(
			owner,
			"mailbox",
			destination,
			parts.map((raw, index) => ({
				filename: `export-${index}.eml`,
				raw: new TextEncoder().encode(raw).buffer,
			})),
		),
	).toEqual({ imported: 1, skipped: 0, errors: [] });
});
test("a slow export keeps a consistent WAL snapshot while inbox writes remain available", async () => {
	for (let i = 0; i < 5; i++)
		state.db
			.query(
				"INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,text_body,created_at) VALUES(?,'owner','mailbox','inbound','from@example.org','hello@example.com',?,'Snapshot body',?)",
			)
			.run(`export-${i}`, `Before ${i}`, i + 2);
	const response = await exportMailbox(owner, "mailbox"),
		reader = response.body!.getReader();
	try {
		const first = await reader.read();
		expect(first.done).toBe(false);
		await bulkAction(owner, { messageIds: ["message"], action: "read" });
		state.db.exec(
			"UPDATE messages SET subject='Changed during export' WHERE id='export-4'",
		);
		let output = new TextDecoder().decode(first.value);
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			output += new TextDecoder().decode(chunk.value);
		}
		expect(output).toContain("Before 4");
		expect(output).not.toContain("Changed during export");
		expect(
			state.db.query("SELECT read FROM messages WHERE id='message'").get(),
		).toEqual({ read: 1 });
	} finally {
		await reader.cancel();
	}
	const cancelled = await exportMailbox(owner, "mailbox");
	await cancelled.body!.cancel();
	expect((await exportMailbox(owner, "mailbox", true)).body).toBeNull();
});

test("export keeps source insertion order for equal dates and uses its streaming index", async () => {
	const insert = state.db.query(
		"INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,created_at) VALUES(?,'owner','mailbox','inbound','sender@example.org','hello@example.com',?,50)",
	);
	insert.run("z-first", "First at same date");
	insert.run("a-second", "Second at same date");
	const output = await (await exportMailbox(owner, "mailbox")).text();
	expect(output.indexOf("First at same date")).toBeLessThan(
		output.indexOf("Second at same date"),
	);
	const plan = state.db
		.query<{ detail: string }, []>(
			"EXPLAIN QUERY PLAN SELECT id FROM messages WHERE mailbox_id='mailbox' AND (created_at,rowid)>(1,1) ORDER BY created_at,rowid LIMIT 1",
		)
		.all()
		.map((row) => row.detail)
		.join(" ");
	expect(plan).toContain("messages_export_page_idx");
	expect(plan).not.toContain("TEMP B-TREE");
});
