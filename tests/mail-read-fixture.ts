import bcrypt from "bcryptjs";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import { owner, stranger } from "./fixtures";
export type ReadSample = {
	name: string;
	kind: "list" | "counts" | "navigation" | "v1";
	query?: string;
	actor?: "owner" | "stranger";
	permission?: string;
	grantSecond?: boolean;
	personal?: boolean;
	disabled?: boolean;
	noBoxes?: boolean;
	blankName?: boolean;
	preferredZone?: string;
	headerZone?: string;
	keyScope?: string[];
	noContacts?: boolean;
	multipleJobs?: boolean;
	attachmentTrash?: boolean;
	outboundHead?: boolean;
};
export const readSamples: ReadSample[] = [];
const list = (name: string, query: string, extra: Partial<ReadSample> = {}) =>
	readSamples.push({ name, kind: "list", query, ...extra });
list("all", "");
list("mailbox", "mailboxId=mailbox");
for (const status of [
	"received",
	"sent",
	"draft",
	"queued",
	"failed",
	"archived",
	"trash",
	"spam",
	"template",
	"unknown",
])
	list(`status-${status}`, `mailboxId=mailbox&status=${status}`);
for (const direction of ["inbound", "outbound", "unknown"])
	list(`direction-${direction}`, `mailboxId=mailbox&direction=${direction}`);
for (const flag of ["starred", "snoozed", "scheduled"])
	for (const value of ["true", "false", "1"])
		list(`${flag}-${value}`, `mailboxId=mailbox&${flag}=${value}`);
for (const read of ["read", "unread", "all", "unknown"])
	list(`read-${read}`, `mailboxId=mailbox&read=${read}`);
list("custom-folder", "mailboxId=mailbox&folderId=read-folder&status=received");
list("missing-folder", "mailboxId=mailbox&folderId=missing");
for (const [name, query] of [
	["text", "alpha"],
	["from", "from:sender@example.org"],
	["to", "to:receiver@example.net"],
	["subject", 'subject:"Invoice alpha"'],
	["attachment", "has:attachment"],
	["date", "after:2026-09-15 before:2026-09-16"],
	["excluded", "alpha -Archived"],
	["starred-operator", "is:starred"],
])
	list(`search-${name}`, `mailboxId=mailbox&q=${encodeURIComponent(query!)}`);
list("title-trim", "mailboxId=mailbox&title=%20Invoice%20%20");
list("empty-title", "mailboxId=mailbox&title=%20%20");
list("grouped-all", "group=thread");
list("grouped-mailbox", "mailboxId=mailbox&group=thread");
list("grouped-inbox", "mailboxId=mailbox&status=received&group=thread");
list("grouped-drafts", "mailboxId=mailbox&status=draft&group=thread");
list("group-ignored", "mailboxId=mailbox&group=false");
for (const limit of ["0", "1", "2", "101", "-1", ""])
	list(`limit-${limit || "empty"}`, `mailboxId=mailbox&limit=${limit}`);
list("offset-page", "mailboxId=mailbox&limit=2&offset=2");
list("offset-negative", "mailboxId=mailbox&offset=-3");
list("offset-empty-page", "mailboxId=mailbox&offset=1000001");
list(
	"duplicate-mailbox-first",
	"mailboxId=mailbox&mailboxId=missing&status=received",
);
list("duplicate-query-first", "mailboxId=mailbox&q=Invoice&q=Private");
list("empty-filters", "mailboxId=&folderId=&direction=&status=&read=&group=");
list("missing-mailbox", "mailboxId=missing");
list("foreign-personal-mailbox", "mailboxId=read-foreign");
list("personal-outgoing-identity", "mailboxId=mailbox&status=sent", {
	personal: true,
});
list("blank-outgoing-identity", "mailboxId=mailbox&status=sent", {
	personal: true,
	blankName: true,
});
list("header-zone", "mailboxId=mailbox&q=after%3A2026-09-15", {
	headerZone: "America/New_York",
});
list("preferred-zone", "mailboxId=mailbox&q=after%3A2026-09-15&timeZone=UTC", {
	preferredZone: "America/New_York",
	headerZone: "Asia/Tokyo",
});
for (const permission of [
	"read_only",
	"send_on_behalf",
	"send_as",
	"full_access",
]) {
	list(`shared-${permission}`, "mailboxId=mailbox", {
		actor: "stranger",
		permission,
	});
	readSamples.push({
		name: `shared-counts-${permission}`,
		kind: "counts",
		query: "mailboxId=mailbox",
		actor: "stranger",
		permission,
	});
}
list("shared-draft-metadata", "mailboxId=mailbox&status=draft", {
	actor: "stranger",
	permission: "read_only",
});
list("shared-grouped", "group=thread", {
	actor: "stranger",
	permission: "read_only",
	grantSecond: true,
});
list("unknown-grant-explicit", "mailboxId=mailbox", {
	actor: "stranger",
	permission: "unknown",
});
list("personal-shared-denied", "mailboxId=mailbox", {
	actor: "stranger",
	permission: "read_only",
	personal: true,
});
list("disabled-explicit", "mailboxId=mailbox", { disabled: true });
list("no-boxes-owner-fallback", "", { noBoxes: true });
list("no-boxes-stranger-fallback", "", { noBoxes: true, actor: "stranger" });
for (const [name, query] of [
	["all", ""],
	["mailbox", "mailboxId=mailbox"],
	["second", "mailboxId=read-second"],
	["missing", "mailboxId=missing"],
	["empty", "mailboxId="],
])
	readSamples.push({ name: `counts-${name}`, kind: "counts", query });
readSamples.push({ name: "counts-no-boxes", kind: "counts", noBoxes: true });
for (const folder of [
	"inbox",
	"starred",
	"snoozed",
	"sent",
	"scheduled",
	"archived",
	"spam",
	"trash",
	"drafts",
	"unknown",
	"",
])
	readSamples.push({
		name: `navigation-${folder || "missing"}`,
		kind: "navigation",
		query: `mailboxId=mailbox&folder=${folder}`,
	});
for (const folder of ["inbox", "starred", "sent"])
	readSamples.push({
		name: `navigation-grouped-${folder}`,
		kind: "navigation",
		query: `mailboxId=mailbox&folder=${folder}&group=thread`,
	});
readSamples.push(
	{
		name: "navigation-global-grouped",
		kind: "navigation",
		query: "folder=starred&group=thread",
	},
	{
		name: "navigation-folder",
		kind: "navigation",
		query: "mailboxId=mailbox&folder=inbox&folderId=read-folder",
	},
	{
		name: "navigation-missing-mailbox",
		kind: "navigation",
		query: "folder=inbox&mailboxId=missing",
	},
);
list("no-contact-names", "mailboxId=mailbox", { noContacts: true });
list("scheduled-multiple-jobs", "mailboxId=mailbox&scheduled=true", {
	multipleJobs: true,
});
list("search-trashed-attachment", "mailboxId=mailbox&q=has%3Aattachment", {
	attachmentTrash: true,
});
readSamples.push({
	name: "navigation-outbound-head",
	kind: "navigation",
	query: "mailboxId=mailbox&folder=starred&group=thread",
	outboundHead: true,
});
for (const [name, query, extra] of [
	["all", "", {}],
	["scoped", "", { keyScope: ["mailbox"] }],
	["empty-scope", "", { keyScope: [] }],
	[
		"shared-read",
		"mailboxId=mailbox",
		{ actor: "stranger", permission: "read_only", keyScope: ["mailbox"] },
	],
	["foreign-box", "mailboxId=read-foreign", {}],
	["out-of-scope", "mailboxId=read-second", { keyScope: ["mailbox"] }],
	["zero", "limit=0", {}],
	["negative", "limit=-1", {}],
	["search", "q=subject%3AInvoice", { keyScope: ["mailbox"] }],
	["direction", "direction=outbound", { keyScope: ["mailbox"] }],
	["no-boxes", "", { noBoxes: true }],
] as const)
	readSamples.push({
		name: "v1-" + name,
		kind: "v1",
		query,
		...extra,
		keyScope: "keyScope" in extra ? [...extra.keyScope] : undefined,
	});
export const readApiKey = "ep_readfixture_only_synthetic_not_a_real_credential";
const readKeyHash = bcrypt.hashSync(readApiKey, 4);
export function readPath(sample: ReadSample) {
	return (
		(sample.kind === "v1"
			? "/api/v1/messages"
			: sample.kind === "list"
				? "/api/messages"
				: `/api/messages/${sample.kind}`) +
		(sample.query ? "?" + sample.query : "")
	);
}
export function readActor(sample: ReadSample) {
	return sample.actor === "stranger"
		? stranger
		: {
				...owner,
				email: "hello@example.com",
				name: sample.blankName ? "" : "Owner",
			};
}
export function prepareReadFixture(db: Database, sample: ReadSample) {
	db.exec(
		"PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; DELETE FROM outbound_jobs; DELETE FROM messages; DELETE FROM contacts; DELETE FROM mailbox_access; DELETE FROM audit_logs; INSERT OR IGNORE INTO mailboxes(id,user_id,domain_id,local_part,display_name,created_at) VALUES('read-second','owner','domain','second','Second inbox',1),('read-foreign','stranger','domain','foreign','Foreign inbox',1),('stranger-mailbox','stranger','domain','stranger',NULL,1); INSERT OR IGNORE INTO folders(id,user_id,mailbox_id,name,color,created_at) VALUES('read-folder','owner','mailbox','Work','#2563eb',1); INSERT INTO license_settings(id,instance_id,plan,state,updated_at) VALUES('default','fixture','team','active',1) ON CONFLICT(id) DO UPDATE SET plan='team',state='active'",
	);
	db.query(
		"UPDATE users SET email='hello@example.com',name=?,time_zone=? WHERE id='owner'",
	).run(sample.blankName ? "" : "Owner", sample.preferredZone ?? null);
	db.exec("UPDATE mailboxes SET disabled=0");
	db.query(
		"UPDATE mailboxes SET type=?,display_name='Primary shared',disabled=? WHERE id='mailbox'",
	).run(sample.personal ? "personal" : "shared", sample.disabled ? 1 : 0);
	db.exec(
		"UPDATE mailboxes SET type='shared',disabled=0 WHERE id='read-second'",
	);
	if (sample.noBoxes) db.exec("UPDATE mailboxes SET disabled=1");
	if (sample.permission)
		for (const box of sample.grantSecond
			? ["mailbox", "read-second"]
			: ["mailbox"])
			db.query(
				"INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES(?,?,'stranger',?,1)",
			).run(`read-${box}`, box, sample.permission);
	const base = Date.parse("2026-09-15T08:00:00Z") / 1000;
	const rows: {
		id: string;
		subject: string;
		status: string;
		dir?: string;
		read?: number;
		star?: number;
		thread?: string;
		folder?: string;
		until?: number;
		box?: string;
		user?: string;
	}[] = [
		{
			id: "in-a",
			subject: "Invoice alpha",
			status: "received",
			thread: "thread-one",
			star: 1,
		},
		{
			id: "in-read",
			subject: "Invoice beta",
			status: "received",
			thread: "thread-one",
			read: 1,
			star: 1,
		},
		{
			id: "out-thread",
			subject: "Sent alpha",
			status: "sent",
			dir: "outbound",
			thread: "thread-one",
			star: 1,
		},
		{
			id: "archived",
			subject: "Archived alpha",
			status: "archived",
			thread: "thread-one",
			read: 1,
		},
		{
			id: "custom",
			subject: "Folder alpha",
			status: "received",
			folder: "read-folder",
		},
		{
			id: "future",
			subject: "Later alpha",
			status: "received",
			until: 4102444800,
			star: 1,
		},
		{ id: "expired", subject: "Expired alpha", status: "received", until: 1 },
		{
			id: "trash",
			subject: "Trash alpha",
			status: "trash",
			thread: "thread-one",
			star: 1,
			until: 4102444800,
		},
		{ id: "spam", subject: "Spam alpha", status: "spam" },
		{
			id: "draft",
			subject: "Draft alpha",
			status: "draft",
			dir: "outbound",
			thread: "thread-one",
		},
		{
			id: "template",
			subject: "Template alpha",
			status: "template",
			dir: "outbound",
			read: 1,
		},
		{
			id: "queued",
			subject: "Scheduled alpha",
			status: "queued",
			dir: "outbound",
			read: 1,
		},
		{
			id: "unclaimed",
			subject: "Unscheduled alpha",
			status: "queued",
			dir: "outbound",
			read: 1,
		},
		{
			id: "second",
			subject: "Second alpha",
			status: "received",
			box: "read-second",
			thread: "thread-one",
			star: 1,
		},
		{
			id: "foreign",
			subject: "Private foreign",
			status: "received",
			box: "read-foreign",
			user: "stranger",
		},
		{
			id: "orphan",
			subject: "Orphan alpha",
			status: "received",
			box: "",
			user: "owner",
		},
	];
	const insert = db.query(
		"INSERT INTO messages(id,user_id,mailbox_id,direction,provider_message_id,from_addr,to_addr,subject,snippet,text_body,status,read,starred,thread_id,folder_id,snoozed_until,created_at,spam_score,spam_verdict,spam_signals,spam_analyzed_at) VALUES(?,?,?,?,?,'Sender <sender@example.org>','Receiver <receiver@example.net>, Other <other@example.net>',?,?,?,?,?,?,?,?,?,?,10,'suspicious','[]',123)",
	);
	for (const [index, row] of rows.entries())
		insert.run(
			row.id,
			row.user ?? "owner",
			row.box === "" ? null : (row.box ?? "mailbox"),
			row.dir ?? "inbound",
			`<${row.id}@example.org>`,
			row.subject,
			`Preview ${row.id}`,
			"Body alpha search token",
			row.status,
			row.read ?? 0,
			row.star ?? 0,
			row.thread ?? null,
			row.folder ?? null,
			row.until ?? null,
			base + index * 60,
		);
	db.exec(
		"UPDATE messages SET trashed_at=123 WHERE status IN('trash','spam'); INSERT INTO outbound_jobs(id,user_id,message_id,status,payload,scheduled_at,created_at,updated_at) VALUES('read-job','owner','queued','queued','{}',4102444800,1,1)",
	);
	db.exec(
		"INSERT INTO message_attachments(id,message_id,filename,content_type,size,disposition,r2_key,created_at) VALUES('read-attachment','in-a','invoice.txt','text/plain',5,'attachment','read/invoice',1),('read-inline','out-thread','image.png','image/png',5,'inline','read/image',1)",
	);
	for (const user of ["owner", "stranger"])
		for (const [name, email] of [
			["sender", "sender@example.org"],
			["recipient", "receiver@example.net"],
		] as const)
			db.query(
				"INSERT INTO contacts(id,user_id,email,display_name,source,last_seen_at,created_at) VALUES(?,?,?,?, 'manual',1,1)",
			).run(
				`${user}-${name}`,
				user,
				email,
				`${user === "owner" ? "Owner" : "Viewer"} ${name}`,
			);
	if (sample.noContacts) db.exec("DELETE FROM contacts");
	if (sample.attachmentTrash)
		db.exec("UPDATE message_attachments SET trashed_at=123");
	if (sample.multipleJobs)
		db.exec(
			"INSERT INTO outbound_jobs(id,user_id,message_id,status,payload,scheduled_at,created_at,updated_at) VALUES('read-job-2','owner','queued','queued','{}',4102444900,2,2)",
		);
	if (sample.outboundHead)
		db.query("UPDATE messages SET created_at=? WHERE id='out-thread'").run(
			base + 86400,
		);
	if (sample.kind === "v1") {
		db.exec("DELETE FROM api_keys");
		db.query(
			"INSERT INTO api_keys(id,user_id,name,key_hash,prefix,scopes,mailbox_scope_enabled,created_at) VALUES('read-key',?,'Read fixture',?,?, '[\"read\"]',?,1)",
		).run(
			sample.actor ?? "owner",
			readKeyHash,
			readApiKey.slice(0, 12),
			sample.keyScope === undefined ? 0 : 1,
		);
		for (const id of sample.keyScope ?? [])
			db.query(
				"INSERT INTO mcp_key_mailboxes(key_id,mailbox_id) VALUES('read-key',?)",
			).run(id);
	}
}
export function normalizeReadBody(value: unknown): unknown {
	if (!value || typeof value !== "object") return value;
	const body = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
	if (Array.isArray(body.messages))
		for (const row of body.messages)
			if (
				row &&
				typeof row === "object" &&
				"threadMessageIds" in row &&
				Array.isArray(row.threadMessageIds)
			)
				row.threadMessageIds.sort();
	if (
		body.counts &&
		typeof body.counts === "object" &&
		"mailboxes" in body.counts &&
		Array.isArray(body.counts.mailboxes)
	)
		body.counts.mailboxes.sort((a, b) =>
			String(a.mailboxId).localeCompare(String(b.mailboxId)),
		);
	return body;
}

// Keep the original capture intact. This is an explicit native security exception:
// public API bodies remain author-only for drafts pending the owner's decision.
export function readExpectedBody(
	sample: ReadSample,
	captured: unknown,
): unknown {
	if (sample.kind !== "v1") return captured;
	const body = z
		.object({
			messages: z
				.array(
					z.object({ status: z.string(), userId: z.string() }).passthrough(),
				)
				.optional(),
		})
		.passthrough()
		.parse(captured);
	if (!body.messages) return body;
	return {
		...body,
		messages: body.messages.filter(
			(message) =>
				message.status !== "draft" || message.userId === readActor(sample).id,
		),
	};
}
