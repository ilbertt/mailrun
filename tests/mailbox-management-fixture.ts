import type { Database } from "bun:sqlite";
import { join } from "node:path";
import {
	prepareSendFixture,
	sendMessageColumns,
} from "./send-contract-fixture";
import { userSchema } from "../src/shared/contracts";
export type MailboxManagementSample = {
	name: string;
	method: "GET" | "POST" | "DELETE";
	path: string;
	fields?: Record<string, unknown>;
	raw?: string;
	actor?: "owner" | "stranger";
	variant?: string;
};
const create = {
	domainId: "domain",
	localPart: "new-inbox",
	displayName: "  New inbox  ",
};
export const mailboxManagementSamples: MailboxManagementSample[] = [];
for (const [name, fields] of [
	["ordinary", create],
	["shared", { ...create, type: "shared" }],
	["explicit-personal", { ...create, type: "personal" }],
	["uppercase", { ...create, localPart: "UPPER" }],
	["spaces", { ...create, localPart: " spaced " }],
	["space-only", { ...create, localPart: " " }],
	["punctuation", { ...create, localPart: "weird!part" }],
	["name-long", { ...create, displayName: "x".repeat(501) }],
	["name-empty", { ...create, displayName: "" }],
	["no-name", { domainId: "domain", localPart: "unnamed" }],
	["no-local", { domainId: "domain" }],
	["blank-local", { ...create, localPart: "" }],
	["long-local", { ...create, localPart: "x".repeat(65) }],
	["missing-domain", { ...create, domainId: "missing" }],
	["blank-domain", { ...create, domainId: "" }],
	["unknown-type", { ...create, type: "invalid" }],
	["bad-name", { ...create, displayName: null }],
	["child-owner", { ...create, ownerUserId: "child" }],
	["disabled-child", { ...create, ownerUserId: "disabled-child" }],
	["foreign-owner", { ...create, ownerUserId: "outsider" }],
	["unknown-owner", { ...create, ownerUserId: "missing" }],
	[
		"shared-ignores-owner",
		{ ...create, type: "shared", ownerUserId: "missing" },
	],
	["exact-mailbox", { ...create, localPart: "hello" }],
	["dot-mailbox", { ...create, localPart: "h.e.l.l.o" }],
	["plus-mailbox", { ...create, localPart: "hello+tag" }],
	["exact-alias", { ...create, localPart: "named" }],
	["dot-alias", { ...create, localPart: "n.a.m.e.d" }],
	["extra", { ...create, ignored: true }],
] as const)
	mailboxManagementSamples.push({
		name: "create-" + name,
		path: "/api/mailboxes",
		method: "POST",
		fields,
	});
for (const variant of [
	"community",
	"pro",
	"expired",
	"stranger-admin",
	"managed-user",
	"unmanaged-user",
	"inactive-domain",
	"disabled-duplicate",
])
	for (const type of ["personal", "shared"])
		mailboxManagementSamples.push({
			name: `create-${variant}-${type}`,
			path: "/api/mailboxes",
			method: "POST",
			fields: {
				...create,
				type,
				domainId:
					variant === "managed-user" || variant === "unmanaged-user"
						? "domain"
						: "domain",
			},
			variant,
			actor: ["stranger-admin", "managed-user", "unmanaged-user"].includes(
				variant,
			)
				? "stranger"
				: "owner",
		});
for (const variant of ["managed-user", "unmanaged-user", "stranger-admin"])
	mailboxManagementSamples.push({
		name: `create-${variant}-foreign-owner`,
		path: "/api/mailboxes",
		method: "POST",
		fields: { ...create, ownerUserId: "child" },
		variant,
		actor: "stranger",
	});
for (const variant of ["owned-domain-user", "no-mailbox-flag"])
	mailboxManagementSamples.push({
		name: "create-" + variant,
		path: "/api/mailboxes",
		method: "POST",
		fields: create,
		variant,
		actor: variant === "owned-domain-user" ? "stranger" : "owner",
	});
for (const raw of ["null", "[]", "{}"])
	mailboxManagementSamples.push({
		name: "create-raw-" + raw,
		path: "/api/mailboxes",
		method: "POST",
		raw,
	});
for (const variant of [
	"ordinary",
	"community",
	"pro",
	"expired",
	"disabled-box",
	"borrowed-older",
	"unknown-grant",
	"primary-case",
	"shared-address-match",
	"all-domain-order",
	"repair",
	"repair-disabled",
	"repair-occupied",
	"repair-foreign-domain",
	"repair-no-domain",
])
	mailboxManagementSamples.push({
		name: "list-" + variant,
		path: "/api/mailboxes",
		method: "GET",
		variant,
	});
for (const method of ["GET", "POST", "DELETE"] as const) {
	for (const variant of [
		"ordinary",
		"community",
		"pro",
		"expired",
		"owner-non-admin",
		"stranger-admin",
		"disabled-box",
		"personal-box",
		"foreign-box",
		"missing-box",
	])
		mailboxManagementSamples.push({
			name: `sharing-${method}-${variant}`,
			path:
				"/api/mailboxes/" +
				(variant === "foreign-box"
					? "borrowed"
					: variant === "missing-box"
						? "missing"
						: "mailbox") +
				"/access" +
				(method === "DELETE" ? "?userId=child" : ""),
			method,
			fields:
				method === "POST"
					? { userId: "child", permission: "send_as" }
					: undefined,
			variant,
			actor: variant === "stranger-admin" ? "stranger" : "owner",
		});
}
for (const permission of [
	"read_only",
	"send_on_behalf",
	"send_as",
	"full_access",
	"unknown",
	null,
])
	mailboxManagementSamples.push({
		name: "sharing-permission-" + permission,
		path: "/api/mailboxes/mailbox/access",
		method: "POST",
		fields: { userId: "child", permission },
	});
for (const userId of [
	"child-admin",
	"disabled-child",
	"outsider",
	"owner",
	"missing",
	"",
])
	mailboxManagementSamples.push({
		name: "sharing-target-" + userId,
		path: "/api/mailboxes/mailbox/access",
		method: "POST",
		fields: { userId, permission: "read_only" },
	});
for (const raw of ["null", "[]", "{}"])
	mailboxManagementSamples.push({
		name: "sharing-raw-" + raw,
		path: "/api/mailboxes/mailbox/access",
		method: "POST",
		raw,
	});
mailboxManagementSamples.push(
	{
		name: "sharing-update-existing",
		path: "/api/mailboxes/mailbox/access",
		method: "POST",
		fields: { userId: "child", permission: "full_access" },
		variant: "existing-grant",
	},
	{
		name: "sharing-validation-before-mailbox",
		path: "/api/mailboxes/missing/access",
		method: "POST",
		fields: { userId: "child", permission: "wrong" },
	},
	{
		name: "sharing-missing-revoke-before-mailbox",
		path: "/api/mailboxes/missing/access",
		method: "DELETE",
	},
	{
		name: "sharing-missing-revoke",
		path: "/api/mailboxes/mailbox/access",
		method: "DELETE",
	},
	{
		name: "sharing-revoke-absent",
		path: "/api/mailboxes/mailbox/access?userId=absent",
		method: "DELETE",
	},
	{
		name: "sharing-existing-disabled-member",
		path: "/api/mailboxes/mailbox/access",
		method: "GET",
		variant: "disabled-member",
	},
);
for (const variant of [
	"ordinary",
	"owner-user",
	"owner-user-manage",
	"owner-user-no-manage",
	"stranger-admin",
	"managed-admin",
	"disabled-box",
	"personal-box",
	"missing-box",
	"queued-job",
	"sending-job",
	"failed-job",
])
	mailboxManagementSamples.push({
		name: "delete-" + variant,
		path:
			"/api/mailboxes/" + (variant === "missing-box" ? "missing" : "mailbox"),
		method: "DELETE",
		variant,
		actor: ["stranger-admin", "managed-admin"].includes(variant)
			? "stranger"
			: "owner",
	});
mailboxManagementSamples.push({
	name: "invalid-grant-body-denial",
	path: "/api/mailboxes/borrowed",
	method: "GET",
	variant: "unknown-grant",
});
mailboxManagementSamples.push(
	{
		name: "list-missing-license-admin",
		path: "/api/mailboxes",
		method: "GET",
		variant: "missing-license-admin",
	},
	{
		name: "list-missing-license-user",
		path: "/api/mailboxes",
		method: "GET",
		variant: "missing-license-user",
	},
);
if (
	new Set(mailboxManagementSamples.map((x) => x.name)).size !==
	mailboxManagementSamples.length
)
	throw new Error("Duplicate mailbox management case");
export function mailboxManagementRequest(
	sample: MailboxManagementSample,
	base: string,
	headers: HeadersInit = {},
) {
	const h = new Headers(headers);
	h.set("Origin", base);
	if (sample.method === "POST") h.set("Content-Type", "application/json");
	return new Request(new URL(sample.path, base), {
		method: sample.method,
		headers: h,
		body:
			sample.method === "POST"
				? (sample.raw ?? JSON.stringify(sample.fields ?? {}))
				: undefined,
	});
}
export function mailboxManagementActor(
	db: Database,
	sample: MailboxManagementSample,
) {
	const row = db
		.query("SELECT id,email,name,role,is_primary_admin FROM users WHERE id=?")
		.get(sample.actor ?? "owner");
	return userSchema.parse({
		...(row as object),
		isPrimaryAdmin: !!(row as { is_primary_admin: number }).is_primary_admin,
	});
}
export async function prepareMailboxManagement(
	db: Database,
	directory: string,
	sample: MailboxManagementSample,
) {
	db.exec(
		"PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;DELETE FROM calendar_events;DELETE FROM auto_reply_deliveries;DELETE FROM routing_rules;DELETE FROM folders;DELETE FROM audit_logs;DELETE FROM mailboxes WHERE id<>'mailbox';DELETE FROM domains WHERE id<>'domain';DELETE FROM users WHERE id NOT IN('owner','stranger')",
	);
	await prepareSendFixture(db, directory, { name: sample.name, kind: "send" });
	db.exec(
		"DELETE FROM message_attachments;DELETE FROM outbound_jobs;DELETE FROM messages;UPDATE domains SET user_id='owner' WHERE id='domain';UPDATE users SET name=CASE id WHEN 'owner' THEN 'Owner' ELSE 'Stranger' END,created_by_user_id=NULL,can_manage_mailboxes=0,can_manage_users=0,can_manage_domains=0,disabled=0,avatar_key=NULL;UPDATE users SET role='user',is_primary_admin=0,email='stranger@example.com' WHERE id='stranger';UPDATE mailboxes SET local_part='hello',use_all_domains=1,type='shared',disabled=0,avatar_key=NULL WHERE id='mailbox';INSERT INTO users(id,email,name,password_hash,role,created_by_user_id,disabled,created_at) VALUES('child','child@example.com','Child','test','user','owner',0,1),('child-admin','admin-child@example.com','Admin child','test','admin','owner',0,1),('disabled-child','disabled@example.com','Disabled','test','user','owner',1,1),('outsider','outsider@example.net','Outsider','test','user',NULL,0,1);INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('z-domain','owner','zebra.example','manual','active',1),('a-domain','owner','alpha.example','manual','active',1),('foreign-domain','stranger','foreign.example','manual','active',1);INSERT INTO mailboxes(id,user_id,domain_id,local_part,display_name,type,created_at) VALUES('owned-z','owner','domain','z-owned','Z owned','personal',20),('owned-a','owner','domain','a-owned','A owned','personal',10),('borrowed','stranger','foreign-domain','borrowed','Borrowed','shared',0);INSERT INTO mailbox_aliases(id,mailbox_id,domain_id,local_part,created_at) VALUES('alias-old','mailbox','domain','named',1),('alias-z','mailbox','z-domain','explicit-z',30),('alias-a','mailbox','a-domain','explicit-a',20);INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_by_user_id,created_at) VALUES('borrowed-share','borrowed','owner','read_only','stranger',1);INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,status,raw_r2_key,created_at) VALUES('stored-message','owner','mailbox','inbound','sender@example.net','hello@example.com','Stored','received','mailbox-mime',1);INSERT INTO message_attachments(id,message_id,filename,content_type,size,r2_key,created_at) VALUES('stored-attachment','stored-message','stored.txt','text/plain',6,'stored.txt',1);INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES('folder','owner','mailbox','Folder',1);INSERT INTO routing_rules(id,user_id,domain_id,scope,pattern,match_field,match_operator,match_value,action,mailbox_id,created_at) VALUES('saved-rule','owner','domain','mailbox','never','sender','exact','never@example.net','trash','mailbox',1)",
	);
	db.exec(
		"INSERT INTO audit_logs(id,actor_user_id,mailbox_id,message_id,action,metadata,created_at) VALUES('retained-audit','owner','mailbox','stored-message','email.receive','{}',1);INSERT INTO calendar_events(id,user_id,mailbox_id,title,starts_at,ends_at,created_at,updated_at) VALUES('retained-event','owner','mailbox','Calendar event',1,3601,1,1);INSERT INTO auto_reply_deliveries(id,mailbox_id,recipient,sent_at) VALUES('reply-record','mailbox','sender@example.net',1)",
	);
	await Bun.write(
		join(directory, "blobs/mailbox-mime"),
		"Synthetic retained MIME",
	);
	const variant = sample.variant ?? "";
	if (variant.startsWith("missing-license"))
		db.exec("DELETE FROM license_settings");
	if (variant === "missing-license-user")
		db.exec("UPDATE users SET role='user',is_primary_admin=0 WHERE id='owner'");
	if (["community", "pro", "expired"].includes(variant))
		db.query(
			"UPDATE license_settings SET plan=?,state=? WHERE id='default'",
		).run(
			variant === "expired" ? "team" : variant,
			variant === "expired" ? "expired" : "active",
		);
	if (
		[
			"owner-user",
			"owner-user-manage",
			"owner-user-no-manage",
			"owner-non-admin",
			"no-mailbox-flag",
		].includes(variant)
	)
		db.exec(
			"UPDATE users SET role='user',is_primary_admin=0,can_manage_mailboxes=" +
				(variant === "owner-user-manage" ? 1 : 0) +
				" WHERE id='owner'",
		);
	if (variant === "stranger-admin" || variant === "managed-admin")
		db.exec("UPDATE users SET role='admin' WHERE id='stranger'");
	if (variant === "managed-admin")
		db.exec("UPDATE users SET created_by_user_id='stranger' WHERE id='owner'");
	if (variant === "managed-user" || variant === "unmanaged-user")
		db.exec(
			"UPDATE users SET created_by_user_id='owner',can_manage_mailboxes=" +
				(variant === "managed-user" ? 1 : 0) +
				" WHERE id='stranger'",
		);
	if (variant === "owned-domain-user")
		db.exec("UPDATE domains SET user_id='stranger' WHERE id='domain'");
	if (variant === "inactive-domain")
		db.exec("UPDATE domains SET status='pending' WHERE id='domain'");
	if (variant === "disabled-box" || variant === "disabled-duplicate")
		db.exec("UPDATE mailboxes SET disabled=1 WHERE id='mailbox'");
	if (variant === "disabled-duplicate")
		db.exec("UPDATE mailboxes SET local_part='new-inbox' WHERE id='mailbox'");
	if (variant === "personal-box")
		db.exec("UPDATE mailboxes SET type='personal' WHERE id='mailbox'");
	if (variant === "primary-case")
		db.exec(
			"UPDATE users SET email='Hello@Example.com' WHERE id='owner';UPDATE mailboxes SET type='personal' WHERE id='mailbox'",
		);
	if (variant === "shared-address-match")
		db.exec(
			"UPDATE users SET email='borrowed@foreign.example' WHERE id='owner'",
		);
	if (variant === "borrowed-older")
		db.exec(
			"INSERT INTO mailboxes(id,user_id,domain_id,local_part,display_name,type,created_at) VALUES('borrowed-z','stranger','foreign-domain','b-z','Borrowed Z','shared',-1);INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_by_user_id,created_at) VALUES('borrowed-z-share','borrowed-z','owner','send_as','stranger',1)",
		);
	if (variant === "all-domain-order")
		db.exec(
			"UPDATE mailboxes SET domain_id='z-domain',local_part='h.e.l.l.o+tag',disabled=1 WHERE id='owned-z'",
		);
	if (variant === "unknown-grant")
		db.exec(
			"UPDATE mailbox_access SET permission='unknown' WHERE id='borrowed-share'",
		);
	if (variant === "existing-grant" || variant === "disabled-member")
		db.exec(
			"INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_by_user_id,created_at) VALUES('existing-member','mailbox','" +
				(variant === "existing-grant" ? "child" : "disabled-child") +
				"','read_only','owner',100)",
		);
	if (variant.startsWith("repair")) {
		db.exec(
			"DELETE FROM mailboxes WHERE id IN('owned-z','owned-a');UPDATE users SET email='repair@example.com' WHERE id='owner'",
		);
		if (variant === "repair-disabled")
			db.exec(
				"UPDATE mailboxes SET type='personal',disabled=1,local_part='repair' WHERE id='mailbox'",
			);
		if (variant === "repair-occupied")
			db.exec("UPDATE mailboxes SET local_part='repair' WHERE id='mailbox'");
		if (variant === "repair-foreign-domain")
			db.exec("UPDATE domains SET user_id='stranger' WHERE id='domain'");
		if (variant === "repair-no-domain")
			db.exec(
				"UPDATE users SET email='repair@missing.example' WHERE id='owner'",
			);
	}
	if (["queued-job", "sending-job", "failed-job"].includes(variant)) {
		db.exec(
			"INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,text_body,status,read,created_at) VALUES('outbound-message','owner','mailbox','outbound','hello@example.com','sender@example.net','Waiting','Waiting','queued',1,1)",
		);
		db.query(
			"INSERT INTO outbound_jobs(id,user_id,message_id,status,payload,scheduled_at,created_at,updated_at) VALUES('outbound-job','owner','outbound-message',?,?,4070952000,1,1)",
		).run(
			variant === "sending-job"
				? "sending"
				: variant === "failed-job"
					? "failed"
					: "queued",
			JSON.stringify({
				userId: "owner",
				mailboxId: "mailbox",
				from: "hello@example.com",
				to: ["sender@example.net"],
				subject: "Waiting",
				text: "Waiting",
			}),
		);
	}
}
export async function mailboxManagementSnapshot(
	db: Database,
	directory: string,
	response: Response,
	started: number,
	resolutions: unknown[],
) {
	const body: unknown = await response.json();
	const boxes = db.query("SELECT * FROM mailboxes ORDER BY rowid").all() as {
			id: string;
		}[],
		grants = db.query("SELECT * FROM mailbox_access ORDER BY rowid").all() as {
			id: string;
		}[];
	const ids = new Map<string, string>();
	for (const box of boxes)
		if (box.id.startsWith("mbx_")) ids.set(box.id, "$new-mailbox");
	for (const grant of grants)
		if (grant.id.startsWith("mac_")) ids.set(grant.id, "$new-grant");
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
	function normalize(value: unknown, key = ""): unknown {
		if (typeof value === "string") {
			if (ids.has(value)) return ids.get(value);
			if (key === "instance_id" && value !== "fixture")
				return "$license-instance";
			if (
				["createdAt", "lastSeenAt"].includes(key) &&
				Date.parse(value) >= started * 1000
			)
				return "$now";
			if (key === "payload") return normalize(JSON.parse(value));
		}
		if (
			typeof value === "number" &&
			["created_at", "updated_at"].includes(key) &&
			value >= started
		)
			return "$now";
		if (Array.isArray(value)) return value.map((v) => normalize(v));
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([k, v]) => [k, normalize(v, k)]),
			);
		return value;
	}
	return normalize({
		status: response.status,
		body,
		mailboxes: boxes,
		grants,
		license: db.query("SELECT * FROM license_settings ORDER BY id").all(),
		messages: db
			.query("SELECT " + sendMessageColumns + " FROM messages ORDER BY rowid")
			.all(),
		jobs: db.query("SELECT * FROM outbound_jobs ORDER BY rowid").all(),
		aliases: db.query("SELECT * FROM mailbox_aliases ORDER BY rowid").all(),
		folders: db.query("SELECT * FROM folders ORDER BY rowid").all(),
		rules: db.query("SELECT * FROM routing_rules ORDER BY rowid").all(),
		audits: db.query("SELECT * FROM audit_logs ORDER BY rowid").all(),
		calendar: db.query("SELECT * FROM calendar_events ORDER BY rowid").all(),
		replies: db
			.query("SELECT * FROM auto_reply_deliveries ORDER BY rowid")
			.all(),
		files: db.query("SELECT * FROM message_attachments ORDER BY rowid").all(),
		objects: objects.sort((a, b) => a.key.localeCompare(b.key)),
		resolutions,
	});
}
export const mailboxResolutionAddresses = [
	"hello@example.com",
	"h.e.l.l.o+tag@example.com",
	"named@example.com",
	"new-inbox@example.com",
	"hello@zebra.example",
];
