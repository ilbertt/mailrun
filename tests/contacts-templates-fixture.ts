import type { Database } from "bun:sqlite";
import {
	prepareSendFixture,
	sendMessageColumns,
} from "./send-contract-fixture";
import { owner, stranger } from "./fixtures";
import { join } from "node:path";
export type Sample = {
	name: string;
	path: string;
	method: string;
	fields?: Record<string, unknown>;
	raw?: string;
	actor?: "owner" | "stranger";
	permission?: string;
	variant?: string;
};
const contact = {
	mailboxId: "mailbox",
	address: "Maya <MAYA@example.net>",
	displayName: "  New name  ",
};
const template = {
	mailboxId: "mailbox",
	from: "hello@example.com",
	title: "  Saved response  ",
	html: "<p>Saved &amp; ready</p>",
	text: "",
};
export const samples: Sample[] = [];
for (const [kind, path, method, fields] of [
	["contact-get", "/api/contacts", "GET", contact],
	["contact-rename", "/api/contacts", "PATCH", contact],
	["contact-block", "/api/contacts/block", "POST", contact],
	["template-create", "/api/templates", "POST", template],
] as const) {
	for (const role of [
		"owner",
		"read_only",
		"send_on_behalf",
		"send_as",
		"full_access",
		"unknown",
		"unshared",
	])
		samples.push({
			name: `${kind}-${role}`,
			path,
			method,
			fields,
			actor: role === "owner" ? "owner" : "stranger",
			permission: ["owner", "unshared"].includes(role) ? undefined : role,
		});
	for (const variant of ["disabled", "personal", "no-team"])
		samples.push({
			name: `${kind}-${variant}`,
			path,
			method,
			fields,
			variant,
			actor: variant === "disabled" ? "owner" : "stranger",
			permission: "full_access",
		});
}
for (const method of ["GET", "PATCH", "POST"]) {
	const path = method === "POST" ? "/api/contacts/block" : "/api/contacts";
	for (const [name, fields] of [
		["missing-mailbox", { ...contact, mailboxId: undefined }],
		["unknown-mailbox", { ...contact, mailboxId: "missing" }],
		["missing-address", { ...contact, address: undefined }],
		["blank-address", { ...contact, address: "  " }],
		["non-email", { ...contact, address: "not an email" }],
		["new-contact", { ...contact, address: "Other <other@example.net>" }],
		["empty-name", { ...contact, displayName: " " }],
		["no-name", { ...contact, displayName: undefined }],
		["long-name", { ...contact, displayName: "n".repeat(101) }],
	] as const)
		samples.push({ name: `contact-${method}-${name}`, path, method, fields });
}
samples.push({
	name: "contact-first-query-value",
	path: "/api/contacts?mailboxId=mailbox&mailboxId=missing&address=maya%40example.net&address=other%40example.net",
	method: "GET",
});
for (const variant of [
	"primary",
	"secondary",
	"explicit-alias",
	"cross-domain",
	"claimed-mailbox",
	"claimed-alias",
	"disabled-claim",
	"inactive-domain",
	"foreign-domain",
	"identity-manager",
	"identity-sync",
])
	for (const method of ["GET", "PATCH"])
		samples.push({
			name: `identity-${method}-${variant}`,
			path: "/api/contacts",
			method,
			variant,
			fields: {
				...contact,
				address:
					variant === "explicit-alias"
						? "named@example.com"
						: variant === "secondary"
							? "secondary@example.com"
							: variant === "primary" ||
									variant === "identity-manager" ||
									variant === "identity-sync"
								? "hello@example.com"
								: "hello@second.example",
			},
			actor: variant === "identity-manager" ? "stranger" : "owner",
			permission: "full_access",
		});
for (const variant of [
	"equivalent-rule",
	"disabled-rule",
	"domain-rule",
	"other-mailbox-rule",
	"existing-blocked",
])
	samples.push({
		name: `block-${variant}`,
		path: "/api/contacts/block",
		method: "POST",
		fields: contact,
		variant,
	});
for (const [name, fields] of [
	["long-title", { ...template, title: "t".repeat(250) }],
	["blank-title", { ...template, title: " " }],
	["missing-title", { ...template, title: undefined }],
	["empty-content", { ...template, text: " ", html: "  " }],
	["text-only", { ...template, html: undefined, text: "  Saved text  " }],
	["null-content", { ...template, html: null, text: null }],
	["no-from", { ...template, from: undefined }],
	["bad-from", { ...template, from: "wrong@example.com" }],
	["no-mailbox", { ...template, mailboxId: undefined }],
	["missing-mailbox", { ...template, mailboxId: "missing" }],
] as const)
	samples.push({
		name: `template-${name}`,
		path: "/api/templates",
		method: "POST",
		fields,
	});
samples.push(
	{
		name: "template-invalid-json",
		path: "/api/templates",
		method: "POST",
		raw: "{",
	},
	{
		name: "template-null-json",
		path: "/api/templates",
		method: "POST",
		raw: "null",
	},
);
for (const variant of ["list", "list-limit", "list-stranger"])
	samples.push({
		name: `template-${variant}`,
		path: "/api/templates",
		method: "GET",
		variant,
		actor: variant === "list-stranger" ? "stranger" : "owner",
	});
for (const variant of [
	"delete",
	"delete-stranger",
	"delete-draft",
	"delete-missing",
	"delete-inbound",
])
	samples.push({
		name: `template-${variant}`,
		path:
			"/api/templates/" +
			(variant === "delete-missing" ? "missing" : "template"),
		method: "DELETE",
		variant,
		actor: variant === "delete-stranger" ? "stranger" : "owner",
	});
export function actor(sample: Sample) {
	return sample.actor === "stranger"
		? stranger
		: { ...owner, email: "hello@example.com" };
}
export function requestFor(
	sample: Sample,
	base: string,
	headers: HeadersInit = {},
) {
	const url = new URL(sample.path, base),
		h = new Headers(headers);
	h.set("Origin", base);
	if (sample.method === "GET" && sample.fields)
		for (const [k, v] of Object.entries(sample.fields))
			if (v !== undefined) url.searchParams.set(k, String(v));
	if (!["GET", "DELETE"].includes(sample.method))
		h.set("Content-Type", "application/json");
	return new Request(url, {
		method: sample.method,
		headers: h,
		body: ["GET", "DELETE"].includes(sample.method)
			? undefined
			: (sample.raw ?? JSON.stringify(sample.fields ?? {})),
	});
}
export async function prepare(db: Database, directory: string, sample: Sample) {
	await prepareSendFixture(db, directory, {
		name: sample.name,
		kind: "send",
		permission: sample.permission,
		variant: ["disabled", "personal", "no-team"].includes(sample.variant ?? "")
			? (sample.variant as "disabled" | "personal" | "no-team")
			: undefined,
	});
	db.exec(
		"DELETE FROM routing_rules; UPDATE users SET name=CASE id WHEN 'owner' THEN 'Owner' ELSE 'Stranger' END,avatar_key=NULL; UPDATE mailboxes SET use_all_domains=0,avatar_key=NULL; DELETE FROM message_attachments; DELETE FROM outbound_jobs; DELETE FROM messages; DELETE FROM mailboxes WHERE id<>'mailbox'; DELETE FROM domains WHERE id<>'domain'; UPDATE contacts SET display_name='Maya',last_seen_at=123,created_at=100 WHERE email='maya@example.net'; DELETE FROM contacts WHERE email<>'maya@example.net'",
	);
	const variant = sample.variant ?? "";
	if (
		variant.startsWith("identity") ||
		[
			"primary",
			"secondary",
			"explicit-alias",
			"cross-domain",
			"claimed-mailbox",
			"claimed-alias",
			"disabled-claim",
			"inactive-domain",
			"foreign-domain",
		].includes(variant)
	) {
		db.exec(
			"UPDATE mailboxes SET type='personal',use_all_domains=1 WHERE id='mailbox'; INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('second','owner','second.example','manual','active',1); INSERT INTO mailboxes(id,user_id,domain_id,local_part,display_name,type,avatar_key,created_at) VALUES('secondary','owner','domain','secondary','Secondary identity','personal','secondary-avatar',1); INSERT INTO mailbox_aliases(id,mailbox_id,domain_id,local_part,created_at) VALUES('named-alias','mailbox','domain','named',1)",
		);
		if (variant === "identity-manager")
			db.exec(
				"UPDATE mailboxes SET type='shared' WHERE id='mailbox'; UPDATE mailboxes SET type='personal' WHERE id='secondary'; UPDATE users SET email='secondary@example.com' WHERE id='owner'",
			);
		if (variant === "identity-manager")
			sample.fields = {
				...sample.fields,
				address: "secondary@example.com",
				mailboxId: "mailbox",
			};
		if (
			["claimed-mailbox", "disabled-claim", "claimed-alias"].includes(variant)
		) {
			db.exec(
				"INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES('claim','stranger','second','other','personal',1)",
			);
			if (variant === "claimed-alias")
				db.exec(
					"INSERT INTO mailbox_aliases(id,mailbox_id,domain_id,local_part,created_at) VALUES('claim-alias','claim','second','h.e.l.l.o+tag',1)",
				);
			else
				db.exec(
					"UPDATE mailboxes SET local_part='h.e.l.l.o+tag',disabled=" +
						(variant === "disabled-claim" ? "1" : "0") +
						" WHERE id='claim'",
				);
		}
		if (variant === "identity-sync") {
			for (const email of [
				"hello@example.com",
				"hello@second.example",
				"secondary@example.com",
				"named@example.com",
			])
				db.query(
					"INSERT INTO contacts(id,user_id,email,display_name,avatar_key,source,blocked,last_seen_at,created_at) VALUES(?,'owner',?,'Old identity','old-avatar','inbound',1,123,100)",
				).run("owner:" + email, email);
		}
		if (variant === "inactive-domain")
			db.exec("UPDATE domains SET status='pending' WHERE id='second'");
		if (variant === "foreign-domain")
			db.exec("UPDATE domains SET user_id='stranger' WHERE id='second'");
	}
	if (
		[
			"equivalent-rule",
			"disabled-rule",
			"domain-rule",
			"other-mailbox-rule",
		].includes(variant)
	) {
		db.exec(
			"INSERT INTO routing_rules(id,user_id,domain_id,scope,pattern,match_field,match_operator,match_value,action,mailbox_id,priority,enabled,created_at) VALUES('preexisting-rule','owner','domain','mailbox','legacy','email','exact','maya@example.net','trash','mailbox',4,1,1)",
		);
		if (variant === "disabled-rule")
			db.exec("UPDATE routing_rules SET enabled=0");
		if (variant === "domain-rule")
			db.exec("UPDATE routing_rules SET scope='domain'");
		if (variant === "other-mailbox-rule")
			db.exec("UPDATE routing_rules SET mailbox_id=NULL");
	}
	if (variant === "existing-blocked") db.exec("UPDATE contacts SET blocked=1");
	db.exec(
		"INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,html_body,text_body,status,raw_r2_key,created_at) VALUES('template','owner','mailbox','outbound','hello@example.com','','Existing template','<p>Existing</p>',NULL,'template','raw-template',100),('template-a','owner','mailbox','outbound','hello@example.com','','Earlier id inserted later',NULL,'Saved','template',NULL,100),('other-template','stranger','mailbox','outbound','hello@example.com','','Other owner',NULL,'Private','template',NULL,200),('not-template','owner','mailbox','outbound','hello@example.com','','Draft',NULL,'Draft','draft',NULL,300); INSERT INTO message_attachments(id,message_id,filename,content_type,size,r2_key,trashed_at,created_at) VALUES('active-template-file','template','active.txt','text/plain',6,'active-template-file',NULL,1),('trashed-template-file','template','trashed.txt','text/plain',7,'trashed-template-file',2,1)",
	);
	for (const key of [
		"raw-template",
		"active-template-file",
		"trashed-template-file",
	])
		await Bun.write(join(directory, "blobs", key), key);
	if (variant === "delete-draft")
		db.exec("UPDATE messages SET status='draft' WHERE id='template'");
	if (variant === "delete-inbound")
		db.exec("UPDATE messages SET direction='inbound' WHERE id='template'");
	if (variant === "list-limit")
		for (let i = 0; i < 205; i++)
			db.query(
				"INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,text_body,status,created_at) VALUES(?,'owner','mailbox','outbound','hello@example.com','',?,'Body','template',?)",
			).run(`bulk-${i}`, `Bulk ${i}`, 400 + i);
}
export async function snapshot(
	db: Database,
	directory: string,
	response: Response,
	started: number,
) {
	const body: unknown = (response.headers.get("content-type") ?? "").includes(
		"json",
	)
		? await response.json()
		: { $text: await response.text() };
	const messages = db
		.query("SELECT " + sendMessageColumns + " FROM messages ORDER BY rowid")
		.all();
	const dynamic = new Map<string, string>();
	for (const row of messages as { id: string }[])
		if (row.id.startsWith("msg_")) dynamic.set(row.id, "$template");
	const objects: { key: string; sha256: string }[] = [];
	for await (const key of new Bun.Glob("**/*").scan({
		cwd: join(directory, "blobs"),
		onlyFiles: true,
		dot: true,
	}))
		if (!key.endsWith(".meta.json"))
			objects.push({
				key,
				sha256: new Bun.CryptoHasher("sha256")
					.update(await Bun.file(join(directory, "blobs", key)).bytes())
					.digest("hex"),
			});
	function normal(value: unknown, key = ""): unknown {
		if (typeof value === "string") {
			if (dynamic.has(value)) return dynamic.get(value);
			if (
				["createdAt", "lastSeenAt"].includes(key) &&
				Date.parse(value) >= started * 1000
			)
				return "$now";
		}
		if (
			typeof value === "number" &&
			["created_at", "last_seen_at"].includes(key) &&
			value >= started
		)
			return "$now";
		if (Array.isArray(value)) return value.map((x) => normal(x));
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([k, v]) => [k, normal(v, k)]),
			);
		return value;
	}
	return normal({
		status: response.status,
		body,
		contacts: db.query("SELECT * FROM contacts ORDER BY user_id,email").all(),
		rules: db.query("SELECT * FROM routing_rules ORDER BY id").all(),
		users: db.query("SELECT id,name,avatar_key FROM users ORDER BY id").all(),
		mailboxes: db
			.query("SELECT id,display_name,avatar_key FROM mailboxes ORDER BY id")
			.all(),
		messages,
		files: db.query("SELECT * FROM message_attachments ORDER BY id").all(),
		objects: objects.sort((a, b) => a.key.localeCompare(b.key)),
	});
}
