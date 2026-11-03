import type { Database } from "bun:sqlite";
import { owner, stranger } from "./fixtures";
export type RuleSample = {
	name: string;
	scope: "inbox" | "domain";
	method: "GET" | "POST" | "PATCH" | "DELETE";
	actor?: "owner" | "stranger";
	permission?: string;
	payload?: unknown;
	id?: string;
	query?: string;
	variant?:
		| "disabled"
		| "personal"
		| "no-team"
		| "owner-user"
		| "delegated"
		| "delegated-denied";
};
export const inboxPayload = {
	mailboxId: "mailbox",
	matchField: "title",
	matchOperator: "contains",
	matchValue: " invoice ",
	destination: "spam",
	priority: 5,
};
export const domainPayload = {
	domainId: "domain",
	name: " Catch all ",
	enabled: true,
	matchField: "recipient",
	matchOperator: "contains",
	matchValue: " * ",
	action: "store",
	mailboxId: "mailbox",
	forwardTo: "",
	keepCopy: false,
	priority: 5,
};
export const ruleSamples: RuleSample[] = [];
for (const scope of ["inbox", "domain"] as const)
	for (const role of [
		"owner",
		"read_only",
		"send_on_behalf",
		"send_as",
		"full_access",
		"unknown",
		"unshared",
	])
		for (const method of ["GET", "POST", "PATCH", "DELETE"] as const)
			ruleSamples.push({
				name: `${scope}-${method}-${role}`,
				scope,
				method,
				actor: role === "owner" ? "owner" : "stranger",
				permission: ["owner", "unshared"].includes(role) ? undefined : role,
				id:
					method === "PATCH" || method === "DELETE"
						? scope === "inbox"
							? "inbox-a"
							: "domain-a"
						: undefined,
				payload: scope === "inbox" ? inboxPayload : domainPayload,
				...(scope === "domain" && role !== "owner"
					? { query: "mailboxId=mailbox" }
					: {}),
			});
for (const variant of ["disabled", "personal", "no-team"] as const)
	for (const scope of ["inbox", "domain"] as const)
		for (const method of ["GET", "POST", "PATCH", "DELETE"] as const)
			ruleSamples.push({
				name: `${scope}-${method}-${variant}`,
				scope,
				method,
				variant,
				actor: variant === "disabled" ? "owner" : "stranger",
				permission: "full_access",
				query: scope === "domain" ? "mailboxId=mailbox" : undefined,
				id:
					method === "PATCH" || method === "DELETE"
						? scope === "inbox"
							? "inbox-a"
							: "domain-a"
						: undefined,
				payload: scope === "inbox" ? inboxPayload : domainPayload,
			});
for (const variant of ["owner-user", "delegated", "delegated-denied"] as const)
	for (const method of ["GET", "POST", "PATCH", "DELETE"] as const)
		ruleSamples.push({
			name: `domain-${method}-${variant}`,
			scope: "domain",
			method,
			variant,
			actor: variant.startsWith("delegated") ? "stranger" : "owner",
			id: method === "PATCH" || method === "DELETE" ? "domain-a" : undefined,
			payload: domainPayload,
		});
for (const method of ["GET", "POST", "PATCH", "DELETE"] as const)
	ruleSamples.push({
		name: `domain-${method}-ordinary-owner-via-mailbox`,
		scope: "domain",
		method,
		variant: "owner-user",
		query: "mailboxId=mailbox",
		id: method === "PATCH" || method === "DELETE" ? "domain-a" : undefined,
		payload: domainPayload,
	});
ruleSamples.push(
	{ name: "inbox-list-no-mailbox", scope: "inbox", method: "GET", query: "" },
	{
		name: "inbox-list-missing-mailbox",
		scope: "inbox",
		method: "GET",
		query: "mailboxId=missing",
	},
	{ name: "domain-list-no-domain", scope: "domain", method: "GET", query: "" },
	{
		name: "domain-list-missing-domain",
		scope: "domain",
		method: "GET",
		query: "domainId=missing",
	},
	{
		name: "domain-list-wrong-context",
		scope: "domain",
		method: "GET",
		query: "domainId=other-domain&mailboxId=mailbox",
	},
	{
		name: "domain-list-missing-context",
		scope: "domain",
		method: "GET",
		query: "domainId=domain&mailboxId=missing",
	},
	{
		name: "domain-list-blank-context",
		scope: "domain",
		method: "GET",
		query: "domainId=domain&mailboxId=",
	},
);
for (const [name, payload] of [
	["trash", { ...inboxPayload, destination: "trash" }],
	["folder", { ...inboxPayload, destination: "folder:target-folder" }],
	[
		"legacy-folder",
		{ ...inboxPayload, destination: undefined, folderId: "target-folder" },
	],
	["missing-destination", { ...inboxPayload, destination: undefined }],
	["empty-folder", { ...inboxPayload, destination: "folder:" }],
	["bad-folder", { ...inboxPayload, destination: "folder:missing" }],
	["foreign-folder", { ...inboxPayload, destination: "folder:foreign-folder" }],
	["long-value", { ...inboxPayload, matchValue: "x".repeat(500) }],
	["overlong-value", { ...inboxPayload, matchValue: "x".repeat(501) }],
	["blank-value", { ...inboxPayload, matchValue: " " }],
	["bad-field", { ...inboxPayload, matchField: "sender" }],
	["bad-operator", { ...inboxPayload, matchOperator: "regex" }],
	["missing-mailbox", { ...inboxPayload, mailboxId: "missing" }],
	["missing-mailbox-field", { matchValue: "a", destination: "spam" }],
	["fractional-priority", { ...inboxPayload, priority: 0.5 }],
	["large-priority", { ...inboxPayload, priority: 20000 }],
	[
		"ignored-domain",
		{ ...inboxPayload, domainId: "foreign-domain", action: "reject" },
	],
] as const)
	for (const method of ["POST", "PATCH"] as const)
		ruleSamples.push({
			name: `inbox-${method}-${name}`,
			scope: "inbox",
			method,
			payload,
			id: method === "PATCH" ? "inbox-a" : undefined,
		});
for (const [name, payload] of [
	[
		"forward",
		{
			...domainPayload,
			action: "forward",
			forwardTo: " next@example.net ",
			mailboxId: null,
		},
	],
	[
		"forward-copy",
		{
			...domainPayload,
			action: "forward",
			forwardTo: " next@example.net ",
			keepCopy: true,
		},
	],
	[
		"reject-clears",
		{
			...domainPayload,
			action: "reject",
			forwardTo: "next@example.net",
			keepCopy: true,
			rejectReason: " blocked ",
		},
	],
	[
		"store-clears",
		{
			...domainPayload,
			action: "store",
			forwardTo: "next@example.net",
			keepCopy: true,
			rejectReason: "unused",
		},
	],
	["no-name", { ...domainPayload, name: undefined }],
	["blank-name", { ...domainPayload, name: " " }],
	["disabled-rule", { ...domainPayload, enabled: false }],
	["disabled-target", { ...domainPayload, mailboxId: "disabled-target" }],
	["foreign-target", { ...domainPayload, mailboxId: "foreign-box" }],
	["other-domain-target", { ...domainPayload, mailboxId: "other-box" }],
	["foreign-domain", { ...domainPayload, domainId: "foreign-domain" }],
	["no-store-target", { ...domainPayload, mailboxId: null }],
	["forward-missing", { ...domainPayload, action: "forward", forwardTo: "" }],
	[
		"copy-no-target",
		{
			...domainPayload,
			action: "forward",
			forwardTo: "next@example.net",
			keepCopy: true,
			mailboxId: null,
		},
	],
	["bad-forward", { ...domainPayload, forwardTo: "bad" }],
	[
		"reject-foreign-target",
		{ ...domainPayload, action: "reject", mailboxId: "foreign-box" },
	],
	["long-value", { ...domainPayload, matchValue: "x".repeat(500) }],
	["overlong-value", { ...domainPayload, matchValue: "x".repeat(501) }],
	[
		"safe-regex",
		{
			...domainPayload,
			matchOperator: "regex",
			matchValue: "^[a-z]+@example\\.com$",
		},
	],
	[
		"nested-regex",
		{ ...domainPayload, matchOperator: "regex", matchValue: "(a+)+$" },
	],
	[
		"invalid-regex",
		{ ...domainPayload, matchOperator: "regex", matchValue: "[" },
	],
	["negative-priority", { ...domainPayload, priority: -1 }],
	["max-priority", { ...domainPayload, priority: 1000 }],
	["high-priority", { ...domainPayload, priority: 1001 }],
	[
		"starts-with",
		{ ...domainPayload, matchOperator: "starts_with", matchValue: "support" },
	],
	[
		"ends-with",
		{
			...domainPayload,
			matchOperator: "ends_with",
			matchValue: "@example.com",
		},
	],
] as const)
	for (const method of ["POST", "PATCH"] as const)
		ruleSamples.push({
			name: `domain-${method}-${name}`,
			scope: "domain",
			method,
			payload,
			id: method === "PATCH" ? "domain-a" : undefined,
		});
ruleSamples.push(
	{
		name: "domain-patch-omitted-domain",
		scope: "domain",
		method: "PATCH",
		id: "domain-a",
		payload: { ...domainPayload, domainId: undefined },
	},
	{
		name: "domain-patch-null",
		scope: "domain",
		method: "PATCH",
		id: "domain-a",
		payload: null,
	},
	{
		name: "domain-patch-authorization-before-validation",
		scope: "domain",
		method: "PATCH",
		id: "domain-a",
		actor: "stranger",
		payload: {},
	},
	{
		name: "domain-post-validation-before-authorization",
		scope: "domain",
		method: "POST",
		actor: "stranger",
		payload: {},
	},
	{
		name: "inbox-post-validation-before-authorization",
		scope: "inbox",
		method: "POST",
		actor: "stranger",
		payload: {},
	},
	{
		name: "inbox-patch-validation-before-missing",
		scope: "inbox",
		method: "PATCH",
		id: "missing",
		payload: {},
	},
	{
		name: "domain-patch-missing-before-validation",
		scope: "domain",
		method: "PATCH",
		id: "missing",
		payload: {},
	},
	{
		name: "inbox-patch-wrong-mailbox",
		scope: "inbox",
		method: "PATCH",
		id: "inbox-a",
		payload: { ...inboxPayload, mailboxId: "rule-target" },
	},
	{
		name: "inbox-patch-domain-row",
		scope: "inbox",
		method: "PATCH",
		id: "domain-a",
		payload: inboxPayload,
	},
	{
		name: "inbox-delete-domain-row",
		scope: "inbox",
		method: "DELETE",
		id: "domain-a",
	},
	{
		name: "inbox-delete-no-mailbox-row",
		scope: "inbox",
		method: "DELETE",
		id: "domain-z",
	},
	{
		name: "domain-patch-inbox-row",
		scope: "domain",
		method: "PATCH",
		id: "inbox-a",
		payload: domainPayload,
	},
	{
		name: "domain-delete-inbox-row",
		scope: "domain",
		method: "DELETE",
		id: "inbox-a",
	},
	{
		name: "inbox-delete-missing",
		scope: "inbox",
		method: "DELETE",
		id: "missing",
	},
	{
		name: "domain-delete-missing",
		scope: "domain",
		method: "DELETE",
		id: "missing",
	},
);
if (
	new Set(ruleSamples.map((sample) => sample.name)).size !== ruleSamples.length
)
	throw new Error("Duplicate rule fixture names");
export function ruleActor(sample: RuleSample) {
	const actor =
		sample.actor === "stranger"
			? stranger
			: { ...owner, email: "hello@example.com" };
	return sample.variant?.startsWith("delegated")
		? { ...actor, role: "admin" as const }
		: sample.variant === "owner-user"
			? { ...actor, role: "user" as const, isPrimaryAdmin: false }
			: actor;
}
export function rulePath(sample: RuleSample) {
	const base =
		"/api/routing-rules" +
		(sample.scope === "domain" ? "/domain" : "") +
		(sample.id ? "/" + sample.id : "");
	const query =
		sample.query ??
		(sample.method === "GET"
			? sample.scope === "domain"
				? "domainId=domain"
				: "mailboxId=mailbox"
			: "");
	return base + (query ? "?" + query : "");
}
export function ruleRequest(
	sample: RuleSample,
	base: string,
	headers?: HeadersInit,
) {
	return new Request(base + rulePath(sample), {
		method: sample.method,
		headers: {
			Origin: base,
			"Content-Type": "application/json",
			...Object.fromEntries(new Headers(headers)),
		},
		...(["POST", "PATCH"].includes(sample.method)
			? { body: JSON.stringify(sample.payload ?? null) }
			: {}),
	});
}
export function prepareRuleFixture(db: Database, sample: RuleSample) {
	db.exec(
		"DELETE FROM routing_rules; DELETE FROM mailbox_access; DELETE FROM folders; UPDATE domains SET zone_id='manual'; UPDATE users SET role='admin',is_primary_admin=1,email='hello@example.com',can_manage_mailboxes=0,created_by_user_id=NULL WHERE id='owner'; UPDATE users SET role='user',is_primary_admin=0,can_manage_mailboxes=0,created_by_user_id=NULL WHERE id='stranger'; UPDATE mailboxes SET disabled=0,type='shared',local_part='hello',display_name='Z inbox' WHERE id='mailbox'; INSERT INTO license_settings(id,instance_id,plan,state,updated_at) VALUES('default','fixture','team','active',1) ON CONFLICT(id) DO UPDATE SET plan='team',state='active'; INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('other-domain','owner','other.example','manual','active',1),('foreign-domain','stranger','foreign.example','manual','active',1) ON CONFLICT(id) DO NOTHING; INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,disabled,created_at) VALUES('stranger-mailbox','stranger','domain','stranger','personal',0,1),('rule-target','stranger','domain','alpha','personal',0,1),('owned-extra','owner','domain','a-team','personal',0,1),('disabled-target','stranger','domain','disabled','personal',1,1),('other-box','owner','other-domain','other','personal',0,1),('foreign-box','stranger','foreign-domain','foreign','personal',0,1) ON CONFLICT(id) DO NOTHING; INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES('target-folder','owner','mailbox','Target',1),('foreign-folder','stranger','rule-target','Foreign',1)",
	);
	const insert = db.query(
		"INSERT INTO routing_rules(id,user_id,domain_id,scope,name,enabled,pattern,match_field,match_operator,match_value,action,mailbox_id,folder_id,forward_to,keep_copy,reject_reason,priority,created_at,match_count,last_matched_at) VALUES(?,?,?,?,?,?,'old','title','contains','old',?,?,?,?,?,?,?,?,7,42)",
	);
	insert.run(
		"inbox-a",
		"owner",
		"domain",
		"mailbox",
		"Preserve metadata",
		0,
		"store",
		"mailbox",
		"target-folder",
		"stale@example.net",
		1,
		"keep reason",
		1,
		20,
	);
	insert.run(
		"inbox-z",
		"owner",
		"domain",
		"mailbox",
		null,
		1,
		"trash",
		"mailbox",
		null,
		null,
		0,
		null,
		90,
		1,
	);
	insert.run(
		"domain-a",
		"stranger",
		"domain",
		"domain",
		"Before",
		1,
		"store",
		"mailbox",
		"target-folder",
		"stale@example.net",
		1,
		"old reason",
		10,
		20,
	);
	insert.run(
		"domain-z",
		"owner",
		"domain",
		"domain",
		null,
		0,
		"reject",
		null,
		null,
		null,
		0,
		"blocked",
		10,
		1,
	);
	insert.run(
		"aaa-tie",
		"owner",
		"domain",
		"domain",
		"Tie",
		1,
		"store",
		"mailbox",
		null,
		null,
		0,
		null,
		10,
		1,
	);
	insert.run(
		"foreign-rule",
		"stranger",
		"foreign-domain",
		"domain",
		null,
		1,
		"store",
		"foreign-box",
		null,
		null,
		0,
		null,
		0,
		1,
	);
	if (sample.permission)
		db.query(
			"INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES('rule-share','mailbox','stranger',?,1)",
		).run(sample.permission);
	if (sample.variant === "disabled")
		db.exec("UPDATE mailboxes SET disabled=1 WHERE id='mailbox'");
	if (sample.variant === "personal")
		db.exec("UPDATE mailboxes SET type='personal' WHERE id='mailbox'");
	if (sample.variant === "no-team")
		db.exec("UPDATE license_settings SET plan='free' WHERE id='default'");
	if (sample.variant === "owner-user")
		db.exec("UPDATE users SET role='user',is_primary_admin=0 WHERE id='owner'");
	if (sample.variant?.startsWith("delegated"))
		db.query(
			"UPDATE users SET role='admin',can_manage_mailboxes=?,created_by_user_id='owner' WHERE id='stranger'",
		).run(sample.variant === "delegated" ? 1 : 0);
}
export async function ruleSnapshot(
	db: Database,
	response: Response,
	started: number,
) {
	const body: unknown = await response.json();
	const rules = db.query("SELECT * FROM routing_rules ORDER BY rowid").all();
	const created = (rules as { id: string }[]).find(
		(row) =>
			![
				"inbox-a",
				"inbox-z",
				"domain-a",
				"domain-z",
				"aaa-tie",
				"foreign-rule",
			].includes(row.id),
	);
	function normalize(value: unknown, key = ""): unknown {
		if (typeof value === "string") {
			if (created) value = value.replaceAll(created.id, "$created-rule");
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
		return key === "created_at" && typeof value === "number" && value >= started
			? "$now"
			: value;
	}
	return normalize({ status: response.status, body, rules });
}
