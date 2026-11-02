import type { Database } from "bun:sqlite";
import { prepareRuleFixture } from "./rule-contract-fixture";
export type EngineSample = {
	name: string;
	kind: "match" | "domain" | "inbox";
	field?: string;
	operator?: string;
	value?: string;
	pattern?: string;
	to?: string;
	from?: string;
	subject?: string;
	content?: string;
	action?: "store" | "forward" | "reject" | "spam" | "trash";
	target?: string | null;
	forwardTo?: string | null;
	keepCopy?: boolean;
	reason?: string | null;
	folder?: string | null;
	disabled?: boolean;
	tie?: boolean;
};
export const engineSamples: EngineSample[] = [];
for (const field of ["email", "sender", "recipient", "title", "content"])
	for (const operator of [
		"contains",
		"exact",
		"starts_with",
		"ends_with",
		"regex",
	]) {
		const address = ["email", "sender", "recipient"].includes(field);
		engineSamples.push({
			name: `match-${field}-${operator}`,
			kind: "match",
			field,
			operator,
			value:
				operator === "regex"
					? address
						? "example\\.net$"
						: "invoice"
					: address
						? "example.net"
						: "invoice",
			from: "Sender <sender@example.net>",
			to: "Recipient <hello@example.net>",
			subject: "An INVOICE title",
			content: "An invoice body",
		});
	}
engineSamples.push(
	{
		name: "match-normalized-pattern",
		kind: "match",
		field: "sender",
		operator: "exact",
		value: "Sender <sender@example.net>",
		from: "Another <sender@example.net>",
	},
	{
		name: "match-empty-value",
		kind: "match",
		field: "title",
		value: "",
		pattern: "",
		subject: "x",
	},
	{
		name: "match-empty-input",
		kind: "match",
		field: "title",
		value: "invoice",
	},
	{
		name: "match-fallback-pattern",
		kind: "match",
		field: "title",
		value: "",
		pattern: "invoice",
		subject: "Invoice",
	},
	{
		name: "match-star-empty-input",
		kind: "match",
		field: "content",
		value: "*",
	},
	{
		name: "match-invalid-regex",
		kind: "match",
		field: "content",
		operator: "regex",
		value: "[",
		content: "x",
	},
	{
		name: "match-nested-regex",
		kind: "match",
		field: "content",
		operator: "regex",
		value: "(a+)+$",
		content: "aaaa",
	},
	{
		name: "match-backreference",
		kind: "match",
		field: "content",
		operator: "regex",
		value: "^(a+)\\1$",
		content: "aaaa",
	},
	{
		name: "match-long-regex",
		kind: "match",
		field: "content",
		operator: "regex",
		value: "x".repeat(300),
		content: "x".repeat(300),
	},
	{
		name: "match-late-regex",
		kind: "match",
		field: "content",
		operator: "regex",
		value: "end$",
		content: "x".repeat(10010) + "end",
	},
	{
		name: "match-unknown-operator",
		kind: "match",
		field: "title",
		operator: "legacy",
		value: "invoice",
		subject: "An invoice",
	},
	{
		name: "domain-reject",
		kind: "domain",
		field: "sender",
		value: "sender@example.net",
		operator: "exact",
		action: "reject",
		reason: " blocked ",
	},
	{
		name: "domain-empty-reason",
		kind: "domain",
		field: "sender",
		value: "sender@example.net",
		operator: "exact",
		action: "reject",
		reason: " ",
	},
	{
		name: "domain-title-before-exact",
		kind: "domain",
		field: "title",
		value: "invoice",
		action: "reject",
		to: "hello@example.com",
		subject: "Invoice",
	},
	{
		name: "domain-content-before-exact",
		kind: "domain",
		field: "content",
		value: "invoice",
		action: "reject",
		to: "hello@example.com",
		content: "Invoice",
	},
	{
		name: "domain-store",
		kind: "domain",
		field: "recipient",
		value: "*",
		action: "store",
	},
	{
		name: "domain-foreign-stored-target",
		kind: "domain",
		field: "recipient",
		value: "*",
		action: "store",
		target: "foreign-box",
	},
	{
		name: "domain-disabled-target",
		kind: "domain",
		field: "recipient",
		value: "*",
		action: "store",
		target: "disabled-target",
	},
	{
		name: "domain-forward-trim",
		kind: "domain",
		field: "recipient",
		value: "*",
		action: "forward",
		forwardTo: " next@example.net ",
		keepCopy: true,
	},
	{
		name: "domain-forward-missing-copy-target",
		kind: "domain",
		field: "recipient",
		value: "*",
		action: "forward",
		forwardTo: "next@example.net",
		keepCopy: true,
		target: "missing",
	},
	{
		name: "domain-forward-disabled-copy-target",
		kind: "domain",
		field: "recipient",
		value: "*",
		action: "forward",
		forwardTo: "next@example.net",
		keepCopy: true,
		target: "disabled-target",
	},
	{
		name: "domain-forward-blank",
		kind: "domain",
		field: "recipient",
		value: "*",
		action: "forward",
		forwardTo: " ",
	},
	{
		name: "domain-nested-regex",
		kind: "domain",
		field: "sender",
		operator: "regex",
		value: "^(a+)+@example\\.net$",
		from: "aaaa@example.net",
		action: "reject",
		reason: "nested",
	},
	{
		name: "domain-tie-order",
		kind: "domain",
		field: "recipient",
		value: "*",
		action: "forward",
		forwardTo: "first@example.net",
		tie: true,
	},
	{
		name: "domain-store-tie",
		kind: "domain",
		field: "recipient",
		value: "*",
		action: "store",
		tie: true,
	},
	{
		name: "inbox-folder",
		kind: "inbox",
		field: "title",
		value: "invoice",
		action: "store",
		folder: "target-folder",
	},
	{
		name: "inbox-trash",
		kind: "inbox",
		field: "content",
		value: "invoice",
		action: "trash",
	},
	{
		name: "inbox-invalid-folder",
		kind: "inbox",
		field: "title",
		value: "invoice",
		action: "store",
		folder: "foreign-folder",
	},
	{
		name: "inbox-missing-folder",
		kind: "inbox",
		field: "title",
		value: "invoice",
		action: "store",
		folder: "missing",
	},
	{
		name: "inbox-disabled",
		kind: "inbox",
		field: "title",
		value: "invoice",
		action: "spam",
		disabled: true,
	},
	{
		name: "inbox-normalized-pattern",
		kind: "inbox",
		field: "email",
		value: "Sender <sender@example.net>",
		operator: "exact",
		action: "spam",
	},
	{
		name: "inbox-legacy-nested-regex",
		kind: "inbox",
		field: "content",
		operator: "regex",
		value: "(a+)+$",
		content: "aaaa",
		action: "spam",
	},
	{
		name: "inbox-late-regex",
		kind: "inbox",
		field: "content",
		operator: "regex",
		value: "end$",
		content: "x".repeat(10010) + "end",
		action: "spam",
	},
	{
		name: "inbox-tie-order",
		kind: "inbox",
		field: "title",
		value: "invoice",
		action: "trash",
		tie: true,
	},
);
export function engineInput(sample: EngineSample) {
	return {
		to: sample.to ?? "unknown@example.com",
		from: sample.from ?? "Sender <sender@example.net>",
		subject: sample.subject ?? "Invoice",
		content: sample.content ?? "Invoice body",
	};
}
export function engineRule(sample: EngineSample) {
	return {
		pattern: sample.pattern ?? "fallback",
		match_field: sample.field ?? "title",
		match_operator: sample.operator ?? "contains",
		match_value: sample.value ?? "invoice",
	};
}
export function prepareRuleEngineFixture(db: Database, sample: EngineSample) {
	prepareRuleFixture(db, { name: "engine", scope: "inbox", method: "GET" });
	db.exec("DELETE FROM routing_rules");
	if (sample.kind === "match") return;
	const rule = engineRule(sample);
	const insert = db.query(
		"INSERT INTO routing_rules(id,user_id,domain_id,scope,enabled,pattern,match_field,match_operator,match_value,action,mailbox_id,folder_id,forward_to,keep_copy,reject_reason,priority,created_at) VALUES(?,'owner','domain',?,?,?,?,?,?,?,?,?,?,?,?,10,1)",
	);
	if (sample.folder === "missing" || sample.target === 'missing') db.exec("PRAGMA foreign_keys=OFF");
	insert.run(
		"z-first",
		sample.kind === "domain" ? "domain" : "mailbox",
		sample.disabled ? 0 : 1,
		rule.pattern,
		rule.match_field,
		rule.match_operator,
		rule.match_value,
		sample.action ?? "store",
		sample.target === undefined ? "mailbox" : sample.target,
		sample.folder ?? null,
		sample.forwardTo ?? null,
		sample.keepCopy ? 1 : 0,
		sample.reason ?? null,
	);
	if (sample.tie)
		insert.run(
			"a-later",
			sample.kind === "domain" ? "domain" : "mailbox",
			1,
			rule.pattern,
			rule.match_field,
			rule.match_operator,
			rule.match_value,
			sample.kind === "domain"
				? sample.action === "store"
					? "store"
					: "reject"
				: "spam",
			sample.kind === "domain"
				? sample.action === "store"
					? "rule-target"
					: null
				: "mailbox",
			null,
			null,
			0,
			"later",
		);
	if (sample.folder === "missing" || sample.target === 'missing') db.exec("PRAGMA foreign_keys=ON");
}
