import type { Database } from "bun:sqlite";
import bcrypt from "bcryptjs";
import { prepareSendFixture, sendSnapshot } from "./send-contract-fixture";
export type V1SendSample = {
	name: string;
	fields?: Record<string, unknown>;
	raw?: string;
	actor?: "owner" | "stranger";
	permission?: string;
	variant?: string;
	auth?: "none" | "basic" | "invalid" | "trimmed";
	scopes?: string[];
	scope?: "empty" | "other" | "all";
	kind?: "legacy" | "mcp";
	failure?: boolean;
	declaredLength?: number;
};
export const V1_TOKEN = "ep_source_public_send_fixture_token_0123456789";
const keyHash = await bcrypt.hash(V1_TOKEN, 4);
export const V1_SEND_FIELDS = {
	mailboxId: "mailbox",
	from: "hello@example.com",
	to: "Maya <maya@example.net>",
	subject: "Public API message",
	text: "API body",
	html: "<p>API body</p>",
};
export const v1SendSamples: V1SendSample[] = [];
for (const role of [
	"owner",
	"read_only",
	"send_on_behalf",
	"send_as",
	"full_access",
	"unknown",
	"unshared",
])
	v1SendSamples.push({
		name: "role-" + role,
		actor: role === "owner" ? "owner" : "stranger",
		permission: ["owner", "unshared"].includes(role) ? undefined : role,
		fields: V1_SEND_FIELDS,
	});
for (const variant of [
	"disabled-box",
	"personal-box",
	"no-team",
	"disabled-user",
	"deleted-key",
])
	v1SendSamples.push({
		name: variant,
		variant,
		actor: ["personal-box", "no-team"].includes(variant) ? "stranger" : "owner",
		permission: "full_access",
		fields: V1_SEND_FIELDS,
	});
for (const scopes of [
	["read"],
	["*"],
	["send"],
	["send", "read"],
	["send", "mailboxes"],
	["accounts"],
	[],
])
	v1SendSamples.push({
		name: "scopes-" + scopes.join(","),
		scopes,
		fields: V1_SEND_FIELDS,
	});
for (const scope of ["empty", "other", "all"] as const)
	v1SendSamples.push({
		name: "mailbox-scope-" + scope,
		scope,
		fields: V1_SEND_FIELDS,
	});
for (const auth of ["none", "basic", "invalid", "trimmed"] as const)
	v1SendSamples.push({ name: "auth-" + auth, auth, fields: V1_SEND_FIELDS });
v1SendSamples.push({
	name: "mcp-unrestricted-legacy",
	kind: "mcp",
	fields: V1_SEND_FIELDS,
	scope: "all",
});
for (const [name, fields] of [
	["ordinary", V1_SEND_FIELDS],
	["scheduled", { ...V1_SEND_FIELDS, scheduledAt: "2099-01-01T00:00:00.123Z" }],
	["past", { ...V1_SEND_FIELDS, scheduledAt: "2000-01-01T00:00:00Z" }],
	[
		"subject-only",
		{
			mailboxId: "mailbox",
			from: "hello@example.com",
			to: "maya@example.net",
			subject: "Subject only",
		},
	],
	["no-from", { ...V1_SEND_FIELDS, from: undefined }],
	["wrong-from", { ...V1_SEND_FIELDS, from: "wrong@example.com" }],
	["no-mailbox", { ...V1_SEND_FIELDS, mailboxId: undefined }],
	["unknown-mailbox", { ...V1_SEND_FIELDS, mailboxId: "missing" }],
	["empty-subject", { ...V1_SEND_FIELDS, subject: "" }],
	["long-subject", { ...V1_SEND_FIELDS, subject: "x".repeat(501) }],
	["invalid-recipient", { ...V1_SEND_FIELDS, to: "invalid" }],
	["single-label-recipient", { ...V1_SEND_FIELDS, to: "recipient@internal" }],
	["no-to", { ...V1_SEND_FIELDS, to: undefined }],
	[
		"threading",
		{
			...V1_SEND_FIELDS,
			cc: ["Copy <cc@example.net>"],
			bcc: "hidden@example.net",
			inReplyTo: "parent@example.net",
			references: ["<root@example.net>", "<parent@example.net>"],
			threadId: "submitted-thread",
		},
	],
	[
		"duplicates",
		{
			...V1_SEND_FIELDS,
			to: [
				" Maya <maya@example.net> ",
				"Other <MAYA@example.net>",
				"cc@example.net",
			],
		},
	],
	["bad-schedule", { ...V1_SEND_FIELDS, scheduledAt: "tomorrow" }],
	[
		"too-many-total",
		{
			...V1_SEND_FIELDS,
			to: Array.from({ length: 50 }, (_, i) => "person" + i + "@example.net"),
			cc: ["extra@example.net"],
		},
	],
] as const)
	v1SendSamples.push({ name, fields });
const file = {
	filename: "note.txt",
	type: "text/plain",
	contentBase64: btoa("API attachment"),
};
for (const [name, attachment] of [
	["file", file],
	["default-type", { filename: "default.bin", contentBase64: btoa("Data") }],
	["upper-type", { ...file, type: "TEXT/PLAIN" }],
	["padded-type", { ...file, type: " text/plain ; charset=UTF-8 " }],
	["slash-name", { ...file, filename: " ../folder\\note.txt " }],
	["nul-name", { ...file, filename: "nul\0name.txt" }],
	["whitespace-name", { ...file, filename: " " }],
	["whitespace-base64", { ...file, contentBase64: " Q U J D \n" }],
	["unpadded-base64", { ...file, contentBase64: "aGVsbG8" }],
	["empty-decoded", { ...file, contentBase64: "   " }],
	["invalid-base64", { ...file, contentBase64: "not!?base64" }],
	["bad-padding", { ...file, contentBase64: "A===" }],
	["empty-base64", { ...file, contentBase64: "" }],
	["scheduled-file", { ...file }],
] as const)
	v1SendSamples.push({
		name,
		fields: {
			...V1_SEND_FIELDS,
			attachments: [attachment],
			...(name === "scheduled-file"
				? { scheduledAt: "2099-01-01T00:00:00Z" }
				: {}),
		},
	});
v1SendSamples.push(
	{
		name: "two-files",
		fields: {
			...V1_SEND_FIELDS,
			attachments: [
				file,
				{ ...file, filename: "second.txt", contentBase64: btoa("Second") },
			],
		},
	},
	{
		name: "file-limit",
		variant: "file-limit",
		fields: { ...V1_SEND_FIELDS, attachments: [file] },
	},
	{
		name: "decode-before-sender",
		fields: {
			...V1_SEND_FIELDS,
			from: "wrong@example.com",
			attachments: [{ ...file, contentBase64: "!?" }],
		},
	},
	{
		name: "scope-before-decode",
		scope: "other",
		fields: {
			...V1_SEND_FIELDS,
			attachments: [{ ...file, contentBase64: "!?" }],
		},
	},
	{ name: "provider-failure", failure: true, fields: V1_SEND_FIELDS },
);
for (const raw of ["{", "null", "[]", "{}", ""])
	v1SendSamples.push({ name: "raw-" + JSON.stringify(raw), raw });
v1SendSamples.push({
	name: "declared-overflow",
	fields: V1_SEND_FIELDS,
	declaredLength: 40 * 1024 * 1024 + 1,
});
v1SendSamples.push(
	{
		name: "overflow-without-key",
		auth: "none",
		fields: V1_SEND_FIELDS,
		declaredLength: 40 * 1024 * 1024 + 1,
	},
	{
		name: "overflow-invalid-key",
		auth: "invalid",
		fields: V1_SEND_FIELDS,
		declaredLength: 40 * 1024 * 1024 + 1,
	},
	{
		name: "overflow-read-key",
		scopes: ["read"],
		fields: V1_SEND_FIELDS,
		declaredLength: 40 * 1024 * 1024 + 1,
	},
);
if (
	new Set(v1SendSamples.map((sample) => sample.name)).size !==
	v1SendSamples.length
)
	throw new Error("Duplicate v1 send case");
export function v1SendRequest(sample: V1SendSample, base: string) {
	const authorization =
		sample.auth === "none"
			? undefined
			: sample.auth === "basic"
				? "Basic " + btoa("ignored:" + V1_TOKEN)
				: sample.auth === "invalid"
					? "Bearer ep_wrong_fixture_key"
					: sample.auth === "trimmed"
						? "Bearer  " + V1_TOKEN + "  "
						: "Bearer " + V1_TOKEN;
	const headers = new Headers({ "Content-Type": "application/json" });
	if (authorization) headers.set("Authorization", authorization);
	if (sample.declaredLength)
		headers.set("Content-Length", String(sample.declaredLength));
	return new Request(base + "/api/v1/send", {
		method: "POST",
		headers,
		body: sample.raw ?? JSON.stringify(sample.fields ?? {}),
	});
}
export async function prepareV1Send(
	db: Database,
	directory: string,
	sample: V1SendSample,
) {
	db.exec(
		"PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;DELETE FROM api_keys;DELETE FROM routing_rules;DELETE FROM mailboxes WHERE id<>'mailbox';DELETE FROM domains WHERE id<>'domain'",
	);
	await prepareSendFixture(db, directory, {
		name: sample.name,
		kind: "send",
		permission: sample.permission,
	});
	db.exec(
		"DELETE FROM message_attachments;DELETE FROM outbound_jobs;DELETE FROM messages;UPDATE users SET name=CASE id WHEN 'owner' THEN 'Owner' ELSE 'Stranger' END,role=CASE id WHEN 'owner' THEN 'admin' ELSE 'user' END,is_primary_admin=CASE id WHEN 'owner' THEN 1 ELSE 0 END;UPDATE mailboxes SET user_id='owner',disabled=0,type='shared',local_part='hello',use_all_domains=0;UPDATE domains SET user_id='owner';INSERT INTO mailbox_aliases(id,mailbox_id,domain_id,local_part,created_at) VALUES('named-alias','mailbox','domain','named',1)",
	);
	const actor = sample.actor ?? "owner";
	db.query(
		"INSERT INTO api_keys(id,user_id,name,prefix,key_hash,kind,scopes,mailbox_scope_enabled,created_at) VALUES('v1-key',?,'Source fixture',?,?,?,?,?,1)",
	).run(
		actor,
		V1_TOKEN.slice(0, 12),
		keyHash,
		sample.kind ?? "legacy",
		JSON.stringify(sample.scopes ?? ["send"]),
		sample.scope === "all" ? 0 : 1,
	);
	if (sample.scope !== "all" && sample.scope !== "empty") {
		if (sample.scope === "other")
			db.exec(
				"INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES('other-box','owner','domain','other','personal',1)",
			);
		db.query(
			"INSERT INTO mcp_key_mailboxes(key_id,mailbox_id) VALUES('v1-key',?)",
		).run(sample.scope === "other" ? "other-box" : "mailbox");
	}
	if (sample.variant === "disabled-box")
		db.exec("UPDATE mailboxes SET disabled=1 WHERE id='mailbox'");
	if (sample.variant === "personal-box")
		db.exec("UPDATE mailboxes SET type='personal' WHERE id='mailbox'");
	if (sample.variant === "no-team")
		db.exec("UPDATE license_settings SET plan='community'");
	if (sample.variant === "disabled-user")
		db.query("UPDATE users SET disabled=1 WHERE id=?").run(actor);
	if (sample.variant === "deleted-key") db.exec("DELETE FROM api_keys");
	if (sample.variant === "file-limit")
		db.exec(
			"INSERT INTO app_settings(id,outbound_attachment_max_mb,updated_at) VALUES('default',0.000001,1) ON CONFLICT(id) DO UPDATE SET outbound_attachment_max_mb=0.000001",
		);
	else
		db.exec(
			"INSERT INTO app_settings(id,outbound_attachment_max_mb,updated_at) VALUES('default',25,1) ON CONFLICT(id) DO UPDATE SET outbound_attachment_max_mb=25",
		);
}
export async function v1SendSnapshot(
	db: Database,
	directory: string,
	response: Response,
	started: number,
	deliveries: unknown[],
) {
	const snapshot = await sendSnapshot(
		db,
		directory,
		response,
		started,
		deliveries,
	);
	return {
		snapshot,
		key: db
			.query(
				"SELECT id,last_used_at IS NOT NULL AS used FROM api_keys ORDER BY id",
			)
			.all(),
	};
}
