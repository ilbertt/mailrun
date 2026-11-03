import type { Database } from "bun:sqlite";
import { owner, stranger } from "./fixtures";
export type AliasSample = {
	name: string;
	method: "GET" | "POST" | "DELETE";
	actor?: "owner" | "stranger";
	permission?: string;
	query?: string;
	payload?: unknown;
	box?: string;
	variant?:
		| "disabled"
		| "personal"
		| "no-team"
		| "foreign-domain"
		| "missing-domain"
		| "pending-domain"
		| "owner-user";
};
export const aliasSamples: AliasSample[] = [];
for (const role of [
	"owner",
	"read_only",
	"send_on_behalf",
	"send_as",
	"full_access",
	"unknown",
	"unshared",
])
	for (const method of ["GET", "POST", "DELETE"] as const)
		aliasSamples.push({
			name: `${method}-${role}`,
			method,
			actor: role === "owner" ? "owner" : "stranger",
			permission: role === "owner" || role === "unshared" ? undefined : role,
			payload: { domainId: "domain", localPart: "added" },
			query: method === "DELETE" ? "aliasId=seed-a" : undefined,
		});
for (const [name, payload] of [
	["simple", { domainId: "domain", localPart: "new-name" }],
	["trim-case", { domainId: "domain", localPart: " NeW.Name " }],
	["plus", { domainId: "domain", localPart: "news+tag" }],
	["bare-plus", { domainId: "domain", localPart: "+" }],
	["duplicate-mailbox", { domainId: "domain", localPart: "hello" }],
	["duplicate-alias", { domainId: "domain", localPart: "old" }],
	["normalized-mailbox", { domainId: "domain", localPart: "h.ello+tag" }],
	["normalized-alias", { domainId: "domain", localPart: "o.ld+tag" }],
	["foreign-domain", { domainId: "foreign-domain", localPart: "new" }],
	["pending-domain", { domainId: "pending-domain", localPart: "new" }],
	["missing-domain", { domainId: "missing", localPart: "new" }],
	["cross-domain", { domainId: "zebra-domain", localPart: "new" }],
	["invalid-local", { domainId: "domain", localPart: "bad name" }],
	["missing-local", { domainId: "domain" }],
	["missing-domain-id", { localPart: "new" }],
	["blank-domain", { domainId: "", localPart: "new" }],
	["long-local", { domainId: "domain", localPart: "x".repeat(65) }],
	["number-local", { domainId: "domain", localPart: 1 }],
	["array", []],
	["null", null],
] as const)
	aliasSamples.push({ name: "create-" + name, method: "POST", payload });
aliasSamples.push(
	{ name: "list-owner-user", method: "GET", variant: "owner-user" },
	{ name: "list-missing-box", method: "GET", box: "missing" },
	{
		name: "create-missing-box",
		method: "POST",
		box: "missing",
		payload: { domainId: "domain", localPart: "new" },
	},
	{ name: "delete-missing-alias", method: "DELETE", query: "aliasId=missing" },
	{
		name: "delete-foreign-alias",
		method: "DELETE",
		query: "aliasId=seed-foreign",
	},
	{ name: "delete-missing-id", method: "DELETE" },
	{
		name: "invalid-before-permission",
		method: "POST",
		actor: "stranger",
		payload: { localPart: "bad name" },
	},
	{ name: "delete-id-before-permission", method: "DELETE", actor: "stranger" },
);
for (const variant of ["disabled", "personal", "no-team"] as const)
	for (const method of ["GET", "POST", "DELETE"] as const)
		aliasSamples.push({
			name: `${method}-${variant}`,
			method,
			variant,
			actor: variant === "disabled" ? "owner" : "stranger",
			permission: "full_access",
			payload: { domainId: "domain", localPart: "new" },
			query: method === "DELETE" ? "aliasId=seed-a" : undefined,
		});
export function aliasActor(sample: AliasSample) {
	const actor =
		sample.actor === "stranger"
			? stranger
			: { ...owner, email: "hello@example.com" };
	return sample.variant === "owner-user"
		? { ...actor, role: "user" as const, isPrimaryAdmin: false }
		: actor;
}
export function aliasPath(sample: AliasSample) {
	return (
		`/api/mailboxes/${sample.box ?? "mailbox"}/aliases` +
		(sample.query ? "?" + sample.query : "")
	);
}
export function aliasRequest(
	sample: AliasSample,
	base: string,
	headers?: HeadersInit,
) {
	return new Request(base + aliasPath(sample), {
		method: sample.method,
		headers: {
			Origin: base,
			"Content-Type": "application/json",
			...Object.fromEntries(new Headers(headers)),
		},
		...(sample.method === "POST"
			? { body: JSON.stringify(sample.payload) }
			: {}),
	});
}
export function prepareAliasFixture(db: Database, sample: AliasSample) {
	db.exec(
		"DELETE FROM mailbox_aliases; DELETE FROM mailbox_access; UPDATE domains SET zone_id='manual'; UPDATE users SET role='admin',is_primary_admin=1,email='hello@example.com' WHERE id='owner'; UPDATE mailboxes SET disabled=0,type='shared' WHERE id='mailbox'; INSERT INTO license_settings(id,instance_id,plan,state,updated_at) VALUES('default','fixture','team','active',1) ON CONFLICT(id) DO UPDATE SET plan='team',state='active'; INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('zebra-domain','owner','zebra.example','manual','active',2),('alpha-domain','owner','alpha.example','manual','active',3),('pending-domain','owner','pending.example','manual','pending',4),('foreign-domain','stranger','foreign.example','manual','active',5) ON CONFLICT(id) DO NOTHING; INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES('foreign-box','stranger','foreign-domain','foreign','personal',2) ON CONFLICT(id) DO NOTHING; INSERT INTO mailbox_aliases(id,mailbox_id,domain_id,local_part,created_at) VALUES('seed-a','mailbox','domain','old',20),('seed-z','mailbox','zebra-domain','zebra',1),('seed-foreign','foreign-box','foreign-domain','other',1)",
	);
	if (sample.permission)
		db.query(
			"INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES('share','mailbox','stranger',?,1)",
		).run(sample.permission);
	if (sample.variant === "disabled")
		db.exec("UPDATE mailboxes SET disabled=1 WHERE id='mailbox'");
	if (sample.variant === "personal")
		db.exec("UPDATE mailboxes SET type='personal' WHERE id='mailbox'");
	if (sample.variant === "no-team")
		db.exec("UPDATE license_settings SET plan='free' WHERE id='default'");
	if (sample.variant === "owner-user")
		db.exec("UPDATE users SET role='user',is_primary_admin=0 WHERE id='owner'");
}
export async function aliasSnapshot(
	db: Database,
	response: Response,
	started: number,
) {
	const body: unknown = await response.json();
	const aliases = db
		.query("SELECT * FROM mailbox_aliases ORDER BY rowid")
		.all();
	const created = (aliases as { id: string }[]).find(
		(row) => !["seed-a", "seed-z", "seed-foreign"].includes(row.id),
	);
	function normalize(value: unknown, key = ""): unknown {
		if (typeof value === "string") {
			if (created) value = value.replaceAll(created.id, "$created-alias");
			if (key === "createdAt" && Date.parse(value as string) >= started * 1000)
				return "$now";
			return value;
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
	return normalize({ status: response.status, body, aliases });
}

export const aliasRoutingCases = [
	{ name: "explicit", to: "old@example.com" },
	{ name: "plus-dot", to: "o.l.d+tag@example.com" },
	{ name: "other-domain", to: "zebra@zebra.example" },
	{ name: "normalized-alias-order", to: "old@example.com", collision: true },
	{
		name: "normalized-alias-newer",
		to: "old@example.com",
		collision: true,
		later: true,
	},
	{
		name: "primary-before-alias",
		to: "h.ello+tag@example.com",
		collision: true,
	},
	{
		name: "disabled-first-alias",
		to: "old@example.com",
		collision: true,
		disabled: true,
	},
	{ name: "cross-domain-fallback", to: "hello@alpha.example" },
	{ name: "unknown", to: "missing@example.com" },
] as const;
export function prepareAliasRoutingFixture(
	db: Database,
	sample: (typeof aliasRoutingCases)[number],
) {
	prepareAliasFixture(db, { name: "routing", method: "GET" });
	db.exec(
		"INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES('routing-second','stranger','domain','second','personal',1) ON CONFLICT(id) DO NOTHING",
	);
	if ("collision" in sample)
		db.exec(
			"INSERT INTO mailbox_aliases(id,mailbox_id,domain_id,local_part,created_at) VALUES('aaa-later','routing-second','domain','o.ld',0),('primary-variant','routing-second','domain','h.ello',0)",
		);
	if ("disabled" in sample)
		db.exec("UPDATE mailboxes SET disabled=1 WHERE id='mailbox'");
	if ("later" in sample)
		db.exec("UPDATE mailbox_aliases SET created_at=99 WHERE id='aaa-later'");
}
