import { withDatabase, seconds } from "../db";
import { getEmailAddress } from "../../lib/email/address";
import { parseAddress } from "../../lib/utils";
import { routingRegexMatches } from "./regex-execution";
export const normalizeLocalPart = (value: string) =>
	(value.split("+")[0] ?? "").replaceAll(".", "").toLowerCase();
type MatchRule = {
	pattern: string;
	match_field: string;
	match_operator: string;
	match_value: string;
};
type MatchInput = {
	to: string;
	from: string;
	subject?: string;
	content?: string;
};
function comparisonValue(field: string, value: string) {
	return ["sender", "recipient", "email"].includes(field)
		? getEmailAddress(value).trim().toLowerCase()
		: value.toLowerCase();
}
export async function matchesRule(rule: MatchRule, input: MatchInput) {
	const pattern = (rule.match_value || rule.pattern).trim();
	if (pattern === "*") return true;
	const target = comparisonValue(rule.match_field, pattern);
	if (!target) return false;
	const values =
		rule.match_field === "sender"
			? [input.from]
			: rule.match_field === "recipient"
				? [input.to]
				: rule.match_field === "title"
					? [input.subject ?? ""]
					: rule.match_field === "content"
						? [input.content ?? ""]
						: [input.from, input.to];
	for (const raw of values) {
		if (!raw) continue;
		const value = comparisonValue(rule.match_field, raw);
		if (!value) continue;
		if (rule.match_operator === "regex") {
			if (await routingRegexMatches(pattern, value)) return true;
		} else if (
			rule.match_operator === "exact"
				? value === target
				: rule.match_operator === "starts_with"
					? value.startsWith(target)
					: rule.match_operator === "ends_with"
						? value.endsWith(target)
						: value.includes(target)
		)
			return true;
	}
	return false;
}
export async function resolveRouting(
	to: string,
	from = "",
	recordMatch = true,
	_content: { subject?: string; content?: string } = {},
) {
	const address = parseAddress(to);
	if (!address) return null;
	const [domain] = await withDatabase(
		(sql) =>
			sql.RoutingDomain`SELECT id,user_id,hostname FROM domains WHERE hostname=${address.domain} AND status='active'`,
	);
	if (!domain) return null;
	const rules = await withDatabase(
		(sql) =>
			sql.DomainRoutingRules`SELECT * FROM routing_rules WHERE domain_id=${domain.id} AND scope='domain' AND enabled=1 ORDER BY priority DESC,created_at`,
	);
	const record = async (ruleId: string) => {
		if (recordMatch)
			await withDatabase(
				(sql) =>
					sql.RecordRoutingMatch`UPDATE routing_rules SET match_count=match_count+1,last_matched_at=${seconds()} WHERE id=${ruleId}`,
			);
	};
	// Like the source resolver, domain matching precedes MIME parsing and sees
	// envelope addresses only. Inbox rules receive subject/content afterward.
	// Regex work stays outside the serialized SQLite callback.
	for (const rule of rules) {
		if (rule.action !== "reject" || !(await matchesRule(rule, { to, from })))
			continue;
		await record(rule.id);
		return {
			action: "reject" as const,
			reason: rule.reject_reason?.trim() || "Message rejected by routing rule",
		};
	}
	const normalized = normalizeLocalPart(address.local);
	const exactCandidates = await withDatabase(
		(sql) => sql.RoutingExactMailboxes`
 /* @notNull id */ /* @notNull user_id */
 SELECT b.id,b.user_id,b.domain_id,b.local_part,b.use_all_domains FROM mailboxes b WHERE b.domain_id=${domain.id} AND b.disabled=0 ORDER BY b.local_part`,
	);
	const exact = exactCandidates.find(
		(box) => normalizeLocalPart(box.local_part) === normalized,
	);
	if (exact) return { action: "store" as const, mailbox: exact };
	const aliases = await withDatabase(
		(sql) => sql.RoutingAliases`
 /* @notNull id */ /* @notNull user_id */
 SELECT b.id,b.user_id,b.domain_id,b.local_part,a.local_part AS alias_local_part FROM mailbox_aliases a JOIN mailboxes b ON b.id=a.mailbox_id WHERE a.domain_id=${domain.id} AND b.disabled=0 ORDER BY a.local_part,a.rowid`,
	);
	const alias = aliases.find(
		(row) => normalizeLocalPart(row.alias_local_part ?? "") === normalized,
	);
	if (alias) return { action: "store" as const, mailbox: alias };
	const crossCandidates = await withDatabase(
		(sql) => sql.RoutingMailboxes`
 /* @notNull id */ /* @notNull user_id */
 SELECT b.id,b.user_id,b.domain_id,b.local_part,b.use_all_domains FROM mailboxes b JOIN domains d ON d.id=b.domain_id WHERE b.disabled=0 AND b.use_all_domains=1 AND d.user_id=${domain.user_id} ORDER BY b.rowid`,
	);
	for (const box of crossCandidates) {
		if (normalizeLocalPart(box.local_part) !== normalized) continue;
		const occupied = await withDatabase(
			(sql) =>
				sql.RoutingCrossDomainOccupied`SELECT id FROM mailboxes WHERE domain_id=${domain.id} AND id!=${box.id} AND replace(lower(substr(local_part,1,instr(local_part||'+','+')-1)),'.','')=${normalized} UNION ALL SELECT id FROM mailbox_aliases WHERE domain_id=${domain.id} AND mailbox_id!=${box.id} AND replace(lower(substr(local_part,1,instr(local_part||'+','+')-1)),'.','')=${normalized} LIMIT 1`,
		);
		if (!occupied.length) return { action: "store" as const, mailbox: box };
	}
	for (const rule of rules) {
		if (
			!["store", "forward"].includes(rule.action) ||
			!(await matchesRule(rule, { to, from }))
		)
			continue;
		const [target] = rule.mailbox_id
			? await withDatabase(
					(sql) => sql.RuleTarget`
  /* @notNull id */ /* @notNull user_id */
  SELECT b.id,b.user_id,b.domain_id,b.local_part FROM mailboxes b WHERE b.id=${rule.mailbox_id} AND b.disabled=0`,
				)
			: [];
		if (rule.action === "forward") {
			const forwardTo = rule.forward_to?.trim();
			if (!forwardTo) continue;
			await record(rule.id);
			return {
				action: "forward" as const,
				forwardTo,
				keepCopy: !!rule.keep_copy && !!target,
				mailbox: target,
			};
		}
		if (target) {
			await record(rule.id);
			return { action: "store" as const, mailbox: target };
		}
	}
	return null;
}
export async function inboxDestination(
	mailboxId: string,
	input: { to: string; from: string; subject: string; content: string },
) {
	const rules = await withDatabase(
		(sql) =>
			sql.InboxRoutingRules`SELECT * FROM routing_rules WHERE mailbox_id=${mailboxId} AND scope='mailbox' AND enabled=1 ORDER BY priority DESC,created_at`,
	);
	for (const rule of rules) {
		if (!(await matchesRule(rule, input))) continue;
		if (rule.action === "spam" || rule.action === "trash")
			return { status: rule.action, folderId: null };
		if (rule.folder_id) {
			const [folder] = await withDatabase(
				(sql) =>
					sql.RuleFolder`SELECT id FROM folders WHERE id=${rule.folder_id} AND mailbox_id=${mailboxId}`,
			);
			if (folder) return { status: "received", folderId: folder.id };
		}
	}
	return { status: "received", folderId: null };
}
