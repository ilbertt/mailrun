import type { Database } from "bun:sqlite";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { owner, stranger } from "./fixtures";
export type SendSample = {
	name: string;
	kind: "send" | "cancel";
	actor?: "owner" | "stranger";
	permission?: string;
	format?: "json" | "form";
	fields?: Record<string, unknown>;
	raw?: string;
	files?: boolean;
	id?: string;
	variant?:
		| "disabled"
		| "personal"
		| "no-team"
		| "foreign-draft"
		| "agent"
		| "missing-file"
		| "foreign-author"
		| "no-job"
		| "sending"
		| "failed"
		| "immediate-job"
		| "sent"
		| "inbound"
		| "orphan"
		| "two-jobs"
		| "provider-failure";
};
export const sendFields = {
	mailboxId: "mailbox",
	from: "hello@example.com",
	to: "Maya <maya@example.net>",
	subject: "Source send",
	text: "Hello\n  world",
	html: "<p>Hello world</p>",
};
export const sendSamples: SendSample[] = [];
for (const kind of ["send", "cancel"] as const)
	for (const role of [
		"owner",
		"read_only",
		"send_on_behalf",
		"send_as",
		"full_access",
		"unknown",
		"unshared",
	])
		sendSamples.push({
			name: `${kind}-${role}`,
			kind,
			actor: role === "owner" ? "owner" : "stranger",
			permission: ["owner", "unshared"].includes(role) ? undefined : role,
			format: "form",
			fields: sendFields,
		});
for (const variant of ["disabled", "personal", "no-team"] as const)
	for (const kind of ["send", "cancel"] as const)
		sendSamples.push({
			name: `${kind}-${variant}`,
			kind,
			actor: variant === "disabled" ? "owner" : "stranger",
			permission: "full_access",
			variant,
			format: "form",
			fields: sendFields,
		});
for (const format of ["json", "form"] as const) {
	for (const [name, fields] of [
		["immediate", sendFields],
		["scheduled", { ...sendFields, scheduledAt: "2099-01-01T12:00:00.123Z" }],
		[
			"subject-only",
			{
				mailboxId: "mailbox",
				from: "hello@example.com",
				to: "maya@example.net",
				subject: "Subject only",
				scheduledAt: "2099-01-01T00:00:00Z",
			},
		],
		["blank-subject", { ...sendFields, subject: "" }],
		["long-subject", { ...sendFields, subject: "x".repeat(501) }],
		["missing-to", { ...sendFields, to: undefined }],
		["bad-to", { ...sendFields, to: "not an address" }],
		["bad-from", { ...sendFields, from: "other@example.com" }],
		["no-from", { ...sendFields, from: undefined }],
		["no-mailbox", { ...sendFields, mailboxId: undefined }],
		["missing-mailbox", { ...sendFields, mailboxId: "missing" }],
		["past", { ...sendFields, scheduledAt: "2000-01-01T00:00:00Z" }],
		["bad-schedule", { ...sendFields, scheduledAt: "tomorrow" }],
		[
			"offset-schedule",
			{ ...sendFields, scheduledAt: "2099-01-01T12:00:00+02:00" },
		],
		["draft", { ...sendFields, draftId: "draft" }],
		[
			"scheduled-draft",
			{ ...sendFields, draftId: "draft", scheduledAt: "2099-01-01T00:00:00Z" },
		],
		["missing-draft", { ...sendFields, draftId: "missing" }],
		[
			"threading",
			{
				...sendFields,
				inReplyTo: "parent@example.org",
				references: "<root@example.org>, <parent@example.org>",
				threadId: "source-thread",
				cc: "Copy <cc@example.net>",
				bcc: "hidden@example.net",
			},
		],
		[
			"duplicates",
			{
				...sendFields,
				to: "Maya <maya@example.net>, Other <MAYA@example.net>",
				scheduledAt: "2099-01-01T00:00:00Z",
			},
		],
	] as const)
		sendSamples.push({
			name: `${format}-${name}`,
			kind: "send",
			format,
			fields,
		});
	for (const variant of [
		"foreign-draft",
		"agent",
		"missing-file",
		"provider-failure",
	] as const)
		sendSamples.push({
			name: `${format}-${variant}`,
			kind: "send",
			format,
			variant,
			fields: {
				...sendFields,
				draftId: variant === "provider-failure" ? undefined : "draft",
			},
		});
}
sendSamples.push(
	{
		name: "form-new-and-stored-immediate",
		kind: "send",
		format: "form",
		files: true,
		fields: { ...sendFields, draftId: "draft" },
	},
	{
		name: "json-header-budget",
		kind: "send",
		format: "json",
		fields: {
			...sendFields,
			references: Array.from(
				{ length: 50 },
				(_, i) => "<" + i + "x".repeat(980) + "@example.net>",
			),
		},
	},
	{
		name: "json-combined-recipient-limit",
		kind: "send",
		format: "json",
		fields: {
			...sendFields,
			to: Array.from({ length: 50 }, (_, i) => `person${i}@example.net`),
			cc: ["hidden@example.net"],
		},
	},
	{
		name: "json-recipient-arrays",
		kind: "send",
		format: "json",
		fields: {
			...sendFields,
			to: ["Maya <maya@example.net>", "cc@example.net"],
			cc: ["hidden@example.net"],
			references: ["<root@example.org>", "<parent@example.org>"],
			scheduledAt: "2099-01-01T00:00:00Z",
		},
	},
	{ name: "json-invalid", kind: "send", format: "json", raw: "{" },
	{
		name: "form-new-and-stored-files",
		kind: "send",
		format: "form",
		files: true,
		fields: {
			...sendFields,
			draftId: "draft",
			scheduledAt: "2099-01-01T00:00:00Z",
		},
	},
	{
		name: "form-new-files",
		kind: "send",
		format: "form",
		files: true,
		fields: sendFields,
	},
	{ name: "cancel-missing", kind: "cancel", id: "missing" },
);
for (const variant of [
	"foreign-author",
	"no-job",
	"sending",
	"failed",
	"immediate-job",
	"sent",
	"inbound",
	"orphan",
	"two-jobs",
] as const)
	sendSamples.push({ name: "cancel-" + variant, kind: "cancel", variant });
if (new Set(sendSamples.map((x) => x.name)).size !== sendSamples.length)
	throw new Error("Duplicate send sample names");
export function sendActor(sample: SendSample) {
	return sample.actor === "stranger"
		? stranger
		: { ...owner, email: "hello@example.com" };
}
export function sendPath(sample: SendSample) {
	return sample.kind === "send"
		? "/api/send"
		: `/api/messages/${sample.id ?? "scheduled"}/cancel-schedule`;
}
export function sendRequest(
	sample: SendSample,
	base: string,
	headers?: HeadersInit,
) {
	const h = new Headers(headers);
	h.set("Origin", base);
	let body: BodyInit | undefined;
	if (sample.kind === "send") {
		if (sample.format === "json") {
			h.set("Content-Type", "application/json");
			body = sample.raw ?? JSON.stringify(sample.fields ?? {});
		} else {
			const form = new FormData();
			for (const [key, value] of Object.entries(sample.fields ?? {}))
				if (value !== undefined && value !== null)
					form.append(key, String(value));
			if (sample.files) {
				form.append(
					"attachments",
					new File(["new attachment"], "new.txt", { type: "text/plain" }),
				);
				form.append("attachments", new File([], "empty.txt"));
				form.append("attachments", "ignored");
			}
			body = form;
		}
	}
	return new Request(base + sendPath(sample), {
		method: "POST",
		headers: h,
		body,
	});
}
export const sendMessageColumns =
	"id,user_id,mailbox_id,direction,provider_message_id,folder_id,from_addr,to_addr,cc_addr,bcc_addr,reply_to,subject,snippet,text_body,html_body,raw_r2_key,status,read,starred,snoozed_until,thread_id,in_reply_to,references_header,spam_score,spam_verdict,spam_signals,spam_analyzed_at,spam_analysis_error,trashed_at,created_at";
export async function prepareSendFixture(
	db: Database,
	directory: string,
	sample: SendSample,
) {
	db.exec(
		"DELETE FROM agent_send_approvals; DELETE FROM agent_draft_metadata; DELETE FROM shared_attachment_links; DELETE FROM outbound_jobs; DELETE FROM message_attachments; DELETE FROM audit_logs; DELETE FROM messages; DELETE FROM mailbox_aliases; DELETE FROM mailbox_access; DELETE FROM contacts; INSERT INTO users(id,email,name,password_hash,role,is_primary_admin,created_at) VALUES('owner','hello@example.com','Owner','test-only','admin',1,1),('stranger','stranger@example.com','Stranger','test-only','user',0,1) ON CONFLICT(id) DO UPDATE SET disabled=0; UPDATE users SET email='hello@example.com',role='admin',is_primary_admin=1 WHERE id='owner'; INSERT INTO domains(id,user_id,hostname,zone_id,status,sending_enabled,sending_provider,created_at) VALUES('domain','owner','example.com','manual','active',1,'cloudflare',1) ON CONFLICT(id) DO UPDATE SET status='active',sending_enabled=1,sending_provider='cloudflare'; INSERT INTO mailboxes(id,user_id,domain_id,local_part,display_name,type,created_at) VALUES('mailbox','owner','domain','hello','Shared Inbox','shared',1) ON CONFLICT(id) DO UPDATE SET disabled=0,type='shared',display_name='Shared Inbox'; INSERT INTO license_settings(id,instance_id,plan,state,updated_at) VALUES('default','fixture','team','active',1) ON CONFLICT(id) DO UPDATE SET plan='team',state='active'",
	);
	if (sample.permission)
		db.query(
			"INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES('send-share','mailbox','stranger',?,1)",
		).run(sample.permission);
	if (sample.variant === "disabled")
		db.exec("UPDATE mailboxes SET disabled=1 WHERE id='mailbox'");
	if (sample.variant === "personal")
		db.exec("UPDATE mailboxes SET type='personal' WHERE id='mailbox'");
	if (sample.variant === "no-team")
		db.exec("UPDATE license_settings SET plan='free' WHERE id='default'");
	db.exec(
		"INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,snippet,text_body,html_body,status,read,starred,thread_id,in_reply_to,references_header,created_at) VALUES('draft','owner','mailbox','outbound','hello@example.com','maya@example.net','Original draft','Before','Before','<p>Before</p>','draft',1,1,'draft-thread','<draft-parent@example.org>','<draft-root@example.org>',1),('scheduled','owner','mailbox','outbound','hello@example.com','maya@example.net','Scheduled original','Scheduled body','Scheduled body',NULL,'queued',1,1,'scheduled-thread','<scheduled-parent@example.org>','<scheduled-root@example.org>',2); INSERT INTO message_attachments(id,message_id,filename,content_type,size,r2_key,disposition,content_id,created_at) VALUES('stored-file','draft','stored.txt','text/plain',6,'stored.txt','inline','source-cid',1)",
	);
	db.query(
		"INSERT INTO outbound_jobs(id,user_id,message_id,status,payload,scheduled_at,created_at,updated_at) VALUES('scheduled-job','owner','scheduled','queued',?,4070952000,1,1)",
	).run(
		JSON.stringify({
			from: "Shared Inbox <hello@example.com>",
			to: ["maya@example.net"],
			subject: "Scheduled original",
			text: "Scheduled body",
		}),
	);
	if (sample.variant === "foreign-draft")
		db.exec("UPDATE messages SET user_id='stranger' WHERE id='draft'");
	if (sample.variant === "agent")
		db.exec(
			"INSERT INTO agent_draft_metadata(draft_id,mailbox_id,origin,revision,created_at) VALUES('draft','mailbox','manual',3,1)",
		);
	if (sample.variant === "foreign-author")
		db.exec("UPDATE messages SET user_id='stranger' WHERE id='scheduled'");
	if (sample.variant === "no-job") db.exec("DELETE FROM outbound_jobs");
	if (sample.variant === "sending" || sample.variant === "failed")
		db.query("UPDATE outbound_jobs SET status=?").run(sample.variant);
	if (sample.variant === "immediate-job")
		db.exec("UPDATE outbound_jobs SET scheduled_at=NULL");
	if (sample.variant === "sent")
		db.exec("UPDATE messages SET status='sent' WHERE id='scheduled'");
	if (sample.variant === "inbound")
		db.exec("UPDATE messages SET direction='inbound' WHERE id='scheduled'");
	if (sample.variant === "orphan")
		db.exec("UPDATE messages SET mailbox_id=NULL WHERE id='scheduled'");
	if (sample.variant === "two-jobs")
		db.query(
			"INSERT INTO outbound_jobs(id,user_id,message_id,status,payload,scheduled_at,created_at,updated_at) SELECT 'immediate-job',user_id,message_id,status,payload,NULL,1,1 FROM outbound_jobs WHERE id='scheduled-job'",
		).run();
	if (
		db
			.query("SELECT name FROM sqlite_master WHERE name='mailrun_installation'")
			.get()
	)
		db.exec(
			"INSERT INTO mailrun_installation(id,account_id,zone_id,hostname,worker_name,public_origin,api_token,relay_secret,relay_version,phase,updated_at) VALUES('primary','account','zone','example.com','fixture','https://send-fixture.example','synthetic-token','synthetic-secret','fixture','ready',1) ON CONFLICT(id) DO NOTHING",
		);
	for (const userId of ["owner", "stranger"])
		for (const email of [
			"maya@example.net",
			"cc@example.net",
			"hidden@example.net",
		])
			db.query(
				"INSERT INTO contacts(id,user_id,email,display_name,source,last_seen_at,created_at) VALUES(?,?,?,NULL,'outbound',1,1)",
			).run(userId + ":" + email, userId, email);
	await rm(join(directory, "blobs"), { recursive: true, force: true });
	await mkdir(join(directory, "blobs"), { recursive: true });
	if (sample.variant !== "missing-file")
		await Bun.write(join(directory, "blobs/stored.txt"), "stored");
}
export async function sendSnapshot(
	db: Database,
	directory: string,
	response: Response,
	started: number,
	deliveries: unknown[] = [],
) {
	const type = response.headers.get("Content-Type") ?? "";
	const body: unknown = type.includes("application/json")
		? await response.json()
		: { $text: await response.text() };
	const messages = db
			.query("SELECT " + sendMessageColumns + " FROM messages ORDER BY rowid")
			.all(),
		jobs = db.query("SELECT * FROM outbound_jobs ORDER BY rowid").all(),
		files = db.query("SELECT * FROM message_attachments ORDER BY rowid").all(),
		contacts = db
			.query("SELECT * FROM contacts WHERE last_seen_at>=? ORDER BY rowid")
			.all(started),
		audits = db.query("SELECT * FROM audit_logs ORDER BY rowid").all();
	const identities = new Map<string, string>();
	let n = 0;
	for (const row of messages as { id: string }[])
		if (!["draft", "scheduled"].includes(row.id))
			identities.set(row.id, "$outbound-" + ++n);
	n = 0;
	for (const row of jobs as { id: string }[])
		if (!["scheduled-job", "immediate-job"].includes(row.id))
			identities.set(row.id, "$job-" + ++n);
	n = 0;
	for (const row of files as { id: string }[])
		if (row.id !== "stored-file") identities.set(row.id, "$attachment-" + ++n);
	n = 0;
	for (const row of audits as { id: string }[])
		identities.set(row.id, "$audit-" + ++n);
	const objects: { key: string; sha256: string }[] = [];
	for await (const key of new Bun.Glob("**/*").scan({
		cwd: join(directory, "blobs"),
		onlyFiles: true,
		dot: true,
	})) {
		if (key.endsWith(".meta.json")) continue;
		objects.push({
			key,
			sha256: new Bun.CryptoHasher("sha256")
				.update(await Bun.file(join(directory, "blobs", key)).bytes())
				.digest("hex"),
		});
	}
	function normalize(value: unknown, key = ""): unknown {
		if (typeof value === "string") {
			for (const [id, replacement] of identities)
				value = (value as string).replaceAll(id, replacement);
			if (key === "payload" || key === "metadata") {
				try {
					return normalize(JSON.parse(value as string) as unknown);
				} catch {}
			}
			if (
				["created_at", "updated_at", "last_seen_at", "sent_at"].includes(key) &&
				Number(value) >= started
			)
				return "$now";
			if (key === "publicOrigin") return "$app-origin";
			return value;
		}
		if (
			typeof value === "number" &&
			["created_at", "updated_at", "last_seen_at", "sent_at"].includes(key) &&
			value >= started
		)
			return "$now";
		if (Array.isArray(value)) return value.map((item) => normalize(item));
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([k, v]) => [k, normalize(v, k)]),
			);
		return value;
	}
	return normalize({
		status: response.status,
		body,
		messages,
		jobs,
		files,
		contacts,
		audits,
		deliveries,
		objects: (normalize(objects) as typeof objects).sort((a, b) =>
			a.key.localeCompare(b.key),
		),
	});
}
