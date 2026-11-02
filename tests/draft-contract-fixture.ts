import type { Database } from "bun:sqlite";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { owner, stranger } from "./fixtures";

export type DraftSample = {
	name: string;
	method: "GET" | "POST" | "PATCH" | "DELETE";
	path: string;
	actor?: "owner" | "stranger";
	payload?: Record<string, unknown>;
	raw?: string;
	files?: "one" | "two" | "empty" | "mixed" | "limit" | "sanitize";
	variant?:
		| "agent"
		| "inbound"
		| "foreign"
		| "sent"
		| "many"
		| "missing-file"
		| "trashed-file"
		| "many-files";
	permission?: string;
};
const payload = {
	mailboxId: "mailbox",
	from: "hello@example.com",
	to: "Maya <maya@example.net>",
	subject: "Draft subject",
	text: "Hello\n  world",
	html: "<p>Hello world</p>",
};
export const draftSamples: DraftSample[] = [
	...[
		"",
		"?mailboxId=mailbox",
		"?mailboxId=missing",
		"?mailboxId=",
		"?limit=1",
	].map((query) => ({
		name: "list" + (query || "-all"),
		method: "GET" as const,
		path: "/api/drafts" + query,
	})),
	{
		name: "list-author-scope",
		method: "GET",
		path: "/api/drafts",
		actor: "stranger",
		permission: "full_access",
	},
	{
		name: "list-limit-100",
		method: "GET",
		path: "/api/drafts",
		variant: "many",
	},
	{ name: "get", method: "GET", path: "/api/drafts/contract-draft" },
	{
		name: "get-inbound-draft",
		method: "GET",
		path: "/api/drafts/contract-draft",
		variant: "inbound",
	},
	{
		name: "get-agent",
		method: "GET",
		path: "/api/drafts/contract-draft",
		variant: "agent",
	},
	{ name: "create", method: "POST", path: "/api/drafts", payload },
	{
		name: "create-html-only",
		method: "POST",
		path: "/api/drafts",
		payload: {
			mailboxId: "mailbox",
			from: "hello@example.com",
			html: "<p>Hello <b>world</b></p>",
		},
	},
	{
		name: "create-empty",
		method: "POST",
		path: "/api/drafts",
		payload: { mailboxId: "mailbox", from: "hello@example.com" },
	},
	{
		name: "create-threading",
		method: "POST",
		path: "/api/drafts",
		payload: {
			...payload,
			cc: "cc@example.net",
			bcc: "bcc@example.net",
			inReplyTo: "<parent@example.net>",
			references: "<root@example.net> <parent@example.net>",
			threadId: "source-thread",
		},
	},
	{
		name: "create-no-from",
		method: "POST",
		path: "/api/drafts",
		payload: { mailboxId: "mailbox" },
	},
	{
		name: "create-no-mailbox",
		method: "POST",
		path: "/api/drafts",
		payload: { from: "hello@example.com" },
	},
	{
		name: "create-wrong-from",
		method: "POST",
		path: "/api/drafts",
		payload: { ...payload, from: "wrong@example.com" },
	},
	{
		name: "create-forward",
		method: "POST",
		path: "/api/drafts",
		payload: { ...payload, forwardOfMessageId: "message" },
	},
	...(["missing-file", "trashed-file", "many-files"] as const).map(
		(variant) => ({
			name: "forward-" + variant,
			method: "POST" as const,
			path: "/api/drafts",
			variant,
			payload: { ...payload, forwardOfMessageId: "message" },
		}),
	),
	{
		name: "create-missing-forward",
		method: "POST",
		path: "/api/drafts",
		payload: { ...payload, forwardOfMessageId: "missing" },
	},
	{
		name: "create-invalid-json",
		method: "POST",
		path: "/api/drafts",
		raw: "{",
	},
	{
		name: "create-large-json",
		method: "POST",
		path: "/api/drafts",
		raw: JSON.stringify({ ...payload, text: "x".repeat(1024 * 1024) }),
	},
	{
		name: "patch",
		method: "PATCH",
		path: "/api/drafts/contract-draft",
		payload,
	},
	{
		name: "patch-html-only",
		method: "PATCH",
		path: "/api/drafts/contract-draft",
		payload: {
			mailboxId: "mailbox",
			from: "hello@example.com",
			html: "<p>Only <b>HTML</b></p>",
		},
	},
	{
		name: "patch-preserves-threading",
		method: "PATCH",
		path: "/api/drafts/contract-draft",
		payload: {
			...payload,
			inReplyTo: "changed",
			references: "changed",
			threadId: "changed",
		},
	},
	{
		name: "patch-invalid-json",
		method: "PATCH",
		path: "/api/drafts/contract-draft",
		raw: "{",
	},
	{
		name: "patch-agent-retains-schedule",
		method: "PATCH",
		path: "/api/drafts/contract-draft",
		variant: "agent",
		payload,
	},
	{
		name: "patch-agent-clear-schedule",
		method: "PATCH",
		path: "/api/drafts/contract-draft",
		variant: "agent",
		payload: { ...payload, scheduledAt: null },
	},
	{
		name: "patch-agent-offset-schedule",
		method: "PATCH",
		path: "/api/drafts/contract-draft",
		variant: "agent",
		payload: { ...payload, scheduledAt: "2099-11-01T12:00+02:00" },
	},
	{
		name: "patch-agent-invalid-schedule",
		method: "PATCH",
		path: "/api/drafts/contract-draft",
		variant: "agent",
		payload: { ...payload, scheduledAt: "2099-11-01" },
	},
	{
		name: "patch-agent-past-schedule",
		method: "PATCH",
		path: "/api/drafts/contract-draft",
		variant: "agent",
		payload: { ...payload, scheduledAt: "2000-01-01T00:00:00Z" },
	},
	{
		name: "patch-agent-missing-mailbox",
		method: "PATCH",
		path: "/api/drafts/contract-draft",
		variant: "agent",
		payload: { from: "hello@example.com" },
	},
	{
		name: "upload-one",
		method: "POST",
		path: "/api/drafts/contract-draft/attachments",
		files: "one",
	},
	{
		name: "upload-two",
		method: "POST",
		path: "/api/drafts/contract-draft/attachments",
		files: "two",
	},
	{
		name: "upload-empty",
		method: "POST",
		path: "/api/drafts/contract-draft/attachments",
		files: "empty",
	},
	{
		name: "upload-invalid-form",
		method: "POST",
		path: "/api/drafts/contract-draft/attachments",
		raw: "not multipart",
	},
	{
		name: "upload-mixed",
		method: "POST",
		path: "/api/drafts/contract-draft/attachments",
		files: "mixed",
	},
	{
		name: "upload-limit",
		method: "POST",
		path: "/api/drafts/contract-draft/attachments",
		files: "limit",
	},
	{
		name: "upload-sanitize",
		method: "POST",
		path: "/api/drafts/contract-draft/attachments",
		files: "sanitize",
	},
	{
		name: "upload-agent",
		method: "POST",
		path: "/api/drafts/contract-draft/attachments",
		files: "one",
		variant: "agent",
	},
	{
		name: "remove",
		method: "DELETE",
		path: "/api/drafts/contract-draft/attachments/existing",
	},
	{
		name: "remove-missing",
		method: "DELETE",
		path: "/api/drafts/contract-draft/attachments/missing",
	},
	{ name: "delete", method: "DELETE", path: "/api/drafts/contract-draft" },
];
for (const method of ["GET", "PATCH", "DELETE"] as const)
	for (const variant of ["foreign", "sent"] as const)
		draftSamples.push({
			name: `${method}-${variant}`,
			method,
			path: "/api/drafts/contract-draft",
			variant,
			payload,
		});
for (const permission of [
	"read_only",
	"send_on_behalf",
	"send_as",
	"full_access",
	"unknown",
	"unshared",
])
	draftSamples.push({
		name: `create-shared-${permission}`,
		method: "POST",
		path: "/api/drafts",
		actor: "stranger",
		permission,
		payload,
	});

export function draftActor(sample: DraftSample) {
	return sample.actor === "stranger"
		? stranger
		: { ...owner, email: "hello@example.com" };
}
export async function prepareDraftFixture(
	db: Database,
	directory: string,
	sample: DraftSample,
) {
	db.exec(
		"DELETE FROM agent_draft_metadata; DELETE FROM message_attachments; DELETE FROM messages; DELETE FROM mailbox_access; DELETE FROM outbound_jobs; UPDATE mailboxes SET disabled=0,type='shared'; UPDATE users SET email='hello@example.com' WHERE id='owner'; INSERT INTO license_settings(id,instance_id,plan,state,updated_at) VALUES('default','fixture','team','active',1) ON CONFLICT(id) DO UPDATE SET plan='team',state='active'",
	);
	if (sample.permission && sample.permission !== "unshared")
		db.query(
			"INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES('draft-share','mailbox','stranger',?,1)",
		).run(sample.permission);
	const stmt = db.query(
		"INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,text_body,html_body,snippet,status,read,in_reply_to,references_header,thread_id,created_at) VALUES(?,?,'mailbox',?,'hello@example.com','maya@example.net','Before','Before body','<p>Before body</p>','Before body',?,1,'<parent@example.net>','<root@example.net>','original-thread',?)",
	);
	stmt.run(
		"contract-draft",
		sample.variant === "foreign" ? "stranger" : "owner",
		sample.variant === "inbound" ? "inbound" : "outbound",
		sample.variant === "sent" ? "sent" : "draft",
		1,
	);
	stmt.run("other-draft", "stranger", "outbound", "draft", 2);
	stmt.run("message", "owner", "inbound", "received", 3);
	if (sample.variant === "many")
		for (let i = 0; i < 104; i++)
			stmt.run(`many-${i}`, "owner", "outbound", "draft", 100 + i);
	await rm(join(directory, "blobs"), { recursive: true, force: true });
	await mkdir(join(directory, "blobs"), { recursive: true });
	for (const [attachment, message] of [
		["existing", "contract-draft"],
		["source-file", "message"],
	] as const) {
		db.query(
			"INSERT INTO message_attachments(id,message_id,filename,content_type,size,r2_key,disposition,content_id,created_at) VALUES(?,?,'before.txt','text/plain',6,?,'inline','cid-before',1)",
		).run(attachment, message, attachment + ".txt");
		await Bun.write(join(directory, "blobs", attachment + ".txt"), "before");
	}
	if (sample.variant === "agent")
		db.exec(
			"INSERT INTO agent_draft_metadata(draft_id,mailbox_id,origin,revision,scheduled_at,created_at) VALUES('contract-draft','mailbox','manual',3,4102444800,1)",
		);
	if (sample.variant === "missing-file")
		await rm(join(directory, "blobs/source-file.txt"));
	if (sample.variant === "trashed-file")
		db.exec(
			"UPDATE message_attachments SET trashed_at=1 WHERE id='source-file'",
		);
	if (sample.variant === "many-files")
		for (let i = 0; i < 11; i++) {
			db.query(
				"INSERT INTO message_attachments(id,message_id,filename,content_type,size,r2_key,created_at) VALUES(?,'message',?,'text/plain',6,?,1)",
			).run("source-" + i, "more-" + i + ".txt", "more-" + i + ".txt");
			await Bun.write(join(directory, "blobs", "more-" + i + ".txt"), "before");
		}
}
export function draftRequest(
	sample: DraftSample,
	base: string,
	headers?: HeadersInit,
) {
	const h = new Headers(headers);
	h.set("Origin", base);
	let body: BodyInit | undefined;
	if (sample.files) {
		const form = new FormData();
		if (sample.files === "mixed") {
			form.append("attachments", "ignored");
			form.append("attachments", new File([], "empty.txt"));
		}
		if (sample.files !== "empty")
			for (
				let i = 0;
				i < (sample.files === "two" ? 2 : sample.files === "limit" ? 10 : 1);
				i++
			)
				form.append(
					"attachments",
					new File(
						["upload-" + i],
						sample.files === "sanitize"
							? "  path\\with\0name.txt  "
							: `upload-${i}.txt`,
						{ type: "text/plain" },
					),
				);
		body = form;
	} else if (sample.method === "POST" || sample.method === "PATCH") {
		h.set("Content-Type", "application/json");
		body = sample.raw ?? JSON.stringify(sample.payload ?? {});
	}
	return new Request(base + sample.path, {
		method: sample.method,
		headers: h,
		body,
	});
}
// Normalize only generated identities/times. Preserve every original field and
// original storage-key structure; object byte hashes are compared separately.
export async function draftSnapshot(
	db: Database,
	directory: string,
	response: Response,
	started: number,
) {
	const body: unknown = await response.json();
	const messages = db
		.query(
			"SELECT id,user_id,mailbox_id,direction,from_addr,to_addr,cc_addr,bcc_addr,subject,snippet,text_body,html_body,status,read,in_reply_to,references_header,thread_id,created_at FROM messages ORDER BY rowid",
		)
		.all();
	const files = db
		.query(
			"SELECT id,message_id,filename,content_type,size,r2_key,disposition,content_id FROM message_attachments ORDER BY rowid",
		)
		.all() as { id: string; r2_key: string }[];
	const agents = db
		.query(
			"SELECT draft_id,mailbox_id,origin,revision,scheduled_at,human_edited_at FROM agent_draft_metadata ORDER BY rowid",
		)
		.all();
	const objects = [];
	for (const file of files) {
		const bytes = Bun.file(join(directory, "blobs", file.r2_key));
		objects.push({
			id: file.id,
			exists: await bytes.exists(),
			...((await bytes.exists())
				? {
						sha256: new Bun.CryptoHasher("sha256")
							.update(await bytes.bytes())
							.digest("hex"),
					}
				: {}),
		});
	}
	const ids = new Map<string, string>();
	for (const row of messages as { id: string }[])
		if (row.id.startsWith("msg_")) ids.set(row.id, "$created-draft");
	let n = 0;
	for (const file of files)
		if (file.id.startsWith("att_")) ids.set(file.id, `$attachment-${++n}`);
	function normalize(value: unknown, key = ""): unknown {
		if (typeof value === "string") {
			for (const [id, replacement] of ids)
				value = (value as string).replaceAll(id, replacement);
			return key === "createdAt" &&
				Date.parse(value as string) >= started * 1000
				? "$now"
				: value;
		}
		if (Array.isArray(value)) return value.map((item) => normalize(item));
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([k, v]) => [k, normalize(v, k)]),
			);
		if (
			(key === "created_at" || key === "human_edited_at") &&
			typeof value === "number" &&
			value >= started
		)
			return "$now";
		return value;
	}
	return normalize({
		status: response.status,
		body,
		messages,
		files,
		agents,
		objects,
	});
}
