import type { Database } from "bun:sqlite";
import {
	prepare as prepareContacts,
	requestFor as contactRequest,
	actor as contactActor,
} from "./contacts-templates-fixture";
export type PreferenceSample = {
	name: string;
	path: string;
	method: "GET" | "PATCH";
	fields?: Record<string, unknown>;
	raw?: string;
	actor?: "owner" | "stranger";
	permission?: string;
	variant?: string;
	headers?: Record<string, string>;
};
export const preferenceSamples: PreferenceSample[] = [];
for (const preference of ["spam", "shortcuts", "recipient-addresses"]) {
	const path = "/api/settings/" + preference;
	for (const variant of ["enabled", "disabled"])
		preferenceSamples.push({
			name: `${preference}-get-${variant}`,
			path,
			method: "GET",
			variant,
		});
	for (const [name, fields] of [
		["true", { enabled: true }],
		["false", { enabled: false }],
		["missing", {}],
		["string", { enabled: "false" }],
		["null", { enabled: null }],
		["number", { enabled: 0 }],
		["extra", { enabled: true, ignored: 1 }],
	] as const)
		preferenceSamples.push({
			name: `${preference}-${name}`,
			path,
			method: "PATCH",
			fields,
		});
	for (const [name, raw] of [
		["invalid-json", "{"],
		["null-json", "null"],
		["array-json", "[]"],
	] as const)
		preferenceSamples.push({
			name: `${preference}-${name}`,
			path,
			method: "PATCH",
			raw,
		});
	preferenceSamples.push({
		name: `${preference}-other-account`,
		path,
		method: "PATCH",
		fields: { enabled: false },
		actor: "stranger",
	});
}
for (const value of [null, 0, -1, 1, 30, 365, 366, 1.5])
	preferenceSamples.push({
		name: `retention-get-${value}`,
		path: "/api/settings/trash-retention",
		method: "GET",
		variant: `retention:${value}`,
	});
for (const value of [null, 0, -1, 1, 7, 365, 366, 1.5, "30", true])
	preferenceSamples.push({
		name: `retention-set-${value}`,
		path: "/api/settings/trash-retention",
		method: "PATCH",
		fields: { days: value },
	});
for (const [name, raw] of [
	["invalid-json", "{"],
	["null-json", "null"],
	["missing", "{}"],
] as const)
	preferenceSamples.push({
		name: `retention-${name}`,
		path: "/api/settings/trash-retention",
		method: "PATCH",
		raw,
	});
const profile = {
	name: "  New owner  ",
	resetEmail: "  recovery@example.net  ",
};
for (const [name, fields] of [
	["basic", profile],
	["empty-reset", { ...profile, resetEmail: "" }],
	["bad-reset", { ...profile, resetEmail: "invalid" }],
	["no-reset", { name: "Name" }],
	["null-reset", { ...profile, resetEmail: null }],
	["blank-name", { ...profile, name: " " }],
	["long-name", { ...profile, name: "x".repeat(101) }],
	["missing-name", { resetEmail: "" }],
	["forward-new", { ...profile, forwardingEmail: "  new@example.net " }],
	["forward-remove", { ...profile, forwardingEmail: "" }],
	["forward-invalid", { ...profile, forwardingEmail: "invalid" }],
	["forward-null", { ...profile, forwardingEmail: null }],
	["extra", { ...profile, unknown: true }],
] as const)
	preferenceSamples.push({
		name: `profile-${name}`,
		path: "/api/settings/profile",
		method: "PATCH",
		fields,
	});
for (const variant of ["community", "pro", "team", "expired"])
	for (const [name, forwardingEmail] of [
		["new", "new@example.net"],
		["same", "old@forward.example"],
		["empty", ""],
	] as const)
		preferenceSamples.push({
			name: `profile-${variant}-${name}`,
			path: "/api/settings/profile",
			method: "PATCH",
			variant,
			fields: { ...profile, forwardingEmail },
		});
for (const variant of ["community", "pro", "team", "expired"])
	for (const value of ["  new@example.net  ", "", "invalid", null])
		preferenceSamples.push({
			name: `forwarding-${variant}-${value}`,
			path: "/api/settings/forwarding",
			method: "PATCH",
			variant,
			fields: { forwardingEmail: value },
		});
for (const path of ["/api/settings/profile", "/api/settings/forwarding"])
	for (const raw of ["{", "null", "[]", "{}"])
		preferenceSamples.push({
			name: `${path.split("/").at(-1)}-raw-${raw}`,
			path,
			method: "PATCH",
			raw,
		});
for (const [name, fields] of [
	["rome", { timeZone: "  Europe/Rome  " }],
	["utc", { timeZone: "UTC" }],
	["clear", { timeZone: null }],
	["invalid", { timeZone: "Not/AZone" }],
	["blank", { timeZone: "" }],
	["missing", {}],
	["number", { timeZone: 12 }],
] as const)
	preferenceSamples.push({
		name: `timezone-${name}`,
		path: "/api/settings/time-zone",
		method: "PATCH",
		fields,
	});
for (const variant of [
	"no-preference",
	"query-zone",
	"header-zone",
	"invalid-preference",
	"preferred-over-query",
	"clear-preference",
])
	preferenceSamples.push({
		name: `timezone-${variant}`,
		path:
			"/api/settings/time-zone" +
			(["query-zone", "preferred-over-query"].includes(variant)
				? "?timeZone=Europe/Paris"
				: ""),
		method: "PATCH",
		variant,
		fields: { timeZone: variant === "clear-preference" ? null : "Asia/Tokyo" },
		headers: { "X-Time-Zone": "America/Los_Angeles" },
	});
for (const raw of ["{", "null", "[]"])
	preferenceSamples.push({
		name: `timezone-raw-${raw}`,
		path: "/api/settings/time-zone",
		method: "PATCH",
		raw,
	});
const mailboxPath = "/api/mailboxes/mailbox";
for (const role of [
	"owner",
	"read_only",
	"send_on_behalf",
	"send_as",
	"full_access",
	"unknown",
	"unshared",
])
	for (const method of ["GET", "PATCH"] as const)
		preferenceSamples.push({
			name: `mailbox-${method}-${role}`,
			path: mailboxPath,
			method,
			fields:
				method === "PATCH"
					? {
							signature: "  <p>Signature</p>  ",
							autoReplyEnabled: true,
							autoReplySubject: "  Away  ",
							autoReplyBody: "  Back soon  ",
						}
					: undefined,
			actor: role === "owner" ? "owner" : "stranger",
			permission: ["owner", "unshared"].includes(role) ? undefined : role,
		});
for (const variant of ["disabled", "personal", "no-team"])
	for (const method of ["GET", "PATCH"] as const)
		preferenceSamples.push({
			name: `mailbox-${method}-${variant}`,
			path: mailboxPath,
			method,
			variant,
			actor: variant === "disabled" ? "owner" : "stranger",
			permission: "full_access",
			fields: { signature: "Signature" },
		});
for (const [name, fields] of [
	["empty", {}],
	["signature-clear", { signature: null }],
	["signature-whitespace", { signature: "  " }],
	["signature-long", { signature: "x".repeat(10001) }],
	[
		"auto-empty",
		{ autoReplyEnabled: true, autoReplySubject: " ", autoReplyBody: "  " },
	],
	["auto-null-subject", { autoReplySubject: null }],
	["auto-null-body", { autoReplyBody: null }],
	["auto-disable", { autoReplyEnabled: false }],
	["auto-long-subject", { autoReplySubject: "x".repeat(201) }],
	["auto-long-body", { autoReplyBody: "x".repeat(10001) }],
	["auto-bad-enabled", { autoReplyEnabled: "true" }],
	["display-trim", { displayName: "  Renamed inbox  " }],
	["display-null", { displayName: null }],
	["display-whitespace", { displayName: " " }],
	["all-domains", { useAllDomains: true }],
	["disable-all-domains", { useAllDomains: false }],
	["invalid-all-domains", { useAllDomains: "true" }],
] as const)
	preferenceSamples.push({
		name: `mailbox-${name}`,
		path: mailboxPath,
		method: "PATCH",
		fields,
	});
for (const variant of ["primary", "secondary"])
	for (const displayName of ["  Renamed identity  ", null, " "])
		preferenceSamples.push({
			name: `mailbox-${variant}-name-${displayName}`,
			path: variant === "secondary" ? "/api/mailboxes/secondary" : mailboxPath,
			method: "PATCH",
			variant,
			fields: { displayName },
		});
for (const method of ["GET", "PATCH"] as const)
	preferenceSamples.push({
		name: `mailbox-${method}-missing`,
		path: "/api/mailboxes/missing",
		method,
		fields: { signature: "Signature" },
	});
preferenceSamples.push({
	name: "mailbox-validation-before-access",
	path: mailboxPath,
	method: "PATCH",
	actor: "stranger",
	fields: { signature: 12 },
});
export const preferenceActor = (sample: PreferenceSample) =>
	contactActor(sample);
export function preferenceRequest(
	sample: PreferenceSample,
	base: string,
	headers: HeadersInit = {},
) {
	const request = contactRequest(sample, base, headers);
	for (const [key, value] of Object.entries(sample.headers ?? {}))
		request.headers.set(key, value);
	return request;
}
export async function preparePreferences(
	db: Database,
	directory: string,
	sample: PreferenceSample,
) {
	db.exec("DELETE FROM calendar_events");
	const mailbox = sample.path.startsWith("/api/mailboxes/");
	await prepareContacts(db, directory, {
		...sample,
		variant: mailbox ? sample.variant : "identity-sync",
	});
	db.exec(
		"UPDATE users SET reset_email='old@recovery.example',forwarding_email='old@forward.example',time_zone='America/New_York',keyboard_shortcuts_enabled=1,spam_protection_enabled=1,show_full_recipient_addresses=1,trash_retention_days=30; UPDATE users SET avatar_key='profile-avatar' WHERE id='owner'; UPDATE mailboxes SET signature='<p>Old signature</p>',auto_reply_enabled=0,auto_reply_subject='Old subject',auto_reply_body='Old body'; UPDATE mailboxes SET type='personal' WHERE id='secondary'",
	);
	if (sample.variant === "enabled" || sample.variant === "disabled") {
		if (!mailbox)
			db.query(
				"UPDATE users SET keyboard_shortcuts_enabled=?,spam_protection_enabled=?,show_full_recipient_addresses=?",
			).run(
				...(Array(3).fill(sample.variant === "enabled" ? 1 : 0) as [
					number,
					number,
					number,
				]),
			);
	}
	if (sample.variant?.startsWith("retention:"))
		db.query("UPDATE users SET trash_retention_days=?").run(
			sample.variant === "retention:null"
				? null
				: Number(sample.variant.split(":")[1]),
		);
	if (["community", "pro", "team", "expired"].includes(sample.variant ?? ""))
		db.query(
			"UPDATE license_settings SET plan=?,state=? WHERE id='default'",
		).run(
			sample.variant === "expired" ? "pro" : (sample.variant ?? "community"),
			sample.variant === "expired" ? "expired" : "active",
		);
	if (
		["no-preference", "query-zone", "header-zone"].includes(
			sample.variant ?? "",
		)
	)
		db.exec("UPDATE users SET time_zone=NULL");
	if (sample.variant === "invalid-preference")
		db.exec("UPDATE users SET time_zone='Bad/Zone'");
	for (const [id, userId, repeat, zone] of [
		["daily", "owner", "daily", null],
		["weekly", "owner", "weekly", null],
		["monthly", "owner", "monthly", null],
		["explicit", "owner", "daily", "Europe/Rome"],
		["single", "owner", "none", null],
		["other", "stranger", "daily", null],
	] as const)
		db.query(
			"INSERT INTO calendar_events(id,user_id,title,repeat,time_zone,starts_at,ends_at,created_at,updated_at) VALUES(?,?,?,?,?,1793340000,1793343600,1,1)",
		).run(id, userId, id, repeat, zone);
}
export async function preferenceSnapshot(
	db: Database,
	response: Response,
	started: number,
) {
	const body: unknown = await response.json();
	const state = {
		status: response.status,
		body,
		users: db
			.query(
				"SELECT id,email,name,reset_email,forwarding_email,time_zone,keyboard_shortcuts_enabled,spam_protection_enabled,show_full_recipient_addresses,trash_retention_days,avatar_key FROM users ORDER BY id",
			)
			.all(),
		mailboxes: db.query("SELECT * FROM mailboxes ORDER BY id").all(),
		contacts: db.query("SELECT * FROM contacts ORDER BY user_id,email").all(),
		calendar: db.query("SELECT * FROM calendar_events ORDER BY id").all(),
	};
	function normalize(value: unknown, key = ""): unknown {
		if (
			typeof value === "string" &&
			["createdAt", "lastSeenAt"].includes(key) &&
			Date.parse(value) >= started * 1000
		)
			return "$now";
		if (
			typeof value === "number" &&
			["created_at", "last_seen_at"].includes(key) &&
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
	return normalize(state);
}
