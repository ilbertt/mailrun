import safeRegex from "safe-regex2";
import { withDatabase, seconds } from "../db";
import { getEmailAddress } from "../../lib/email/address";
import { parseAddress } from "../../lib/utils";

export const normalizeLocalPart = (value: string) =>
	(value.split("+")[0] ?? "").replaceAll(".", "").toLowerCase();
type Rule = {
	id: string;
	pattern: string;
	match_field: string;
	match_operator: string;
	match_value: string;
	action: string;
	mailbox_id: string | null;
	folder_id: string | null;
	forward_to: string | null;
	keep_copy: number;
	reject_reason: string | null;
};
export function matchesRule(
	rule: Pick<
		Rule,
		"pattern" | "match_field" | "match_operator" | "match_value"
	>,
	input: { to: string; from: string; subject?: string; content?: string },
) {
	const pattern = (rule.match_value || rule.pattern).trim();
	if (pattern === "*") return true;
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
	return values.some((raw) => {
		const value = ["sender", "recipient", "email"].includes(rule.match_field)
			? getEmailAddress(raw).toLowerCase()
			: raw.toLowerCase();
		if (rule.match_operator === "regex") {
			try {
				return (
					pattern.length <= 256 &&
					safeRegex(pattern) &&
					new RegExp(pattern, "i").test(value.slice(0, 10000))
				);
			} catch {
				return false;
			}
		}
		const target = pattern.toLowerCase();
		return rule.match_operator === "exact"
			? value === target
			: rule.match_operator === "starts_with"
				? value.startsWith(target)
				: rule.match_operator === "ends_with"
					? value.endsWith(target)
					: value.includes(target);
	});
}
export async function resolveRouting(
	to: string,
	from = "",
	recordMatch = true,
	content: { subject?: string; content?: string } = {},
) {
	const address = parseAddress(to);
	if (!address) return null;
	return withDatabase(async (sql) => {
		const [domain] =
			await sql.RoutingDomain`SELECT id,user_id,hostname FROM domains WHERE hostname=${address.domain} AND status='active'`;
		if (!domain) return null;
		const rules =
			await sql.DomainRoutingRules`SELECT * FROM routing_rules WHERE domain_id=${domain.id} AND scope='domain' AND enabled=1 ORDER BY priority DESC,created_at,id`;
		const block = rules.find(
			(rule) =>
				rule.action === "reject" && matchesRule(rule, { to, from, ...content }),
		);
		const record = async (ruleId: string) => {
			if (recordMatch)
				await sql.RecordRoutingMatch`UPDATE routing_rules SET match_count=match_count+1,last_matched_at=${seconds()} WHERE id=${ruleId}`;
		};
		if (block) {
			await record(block.id);
			return {
				action: "reject" as const,
				reason: block.reject_reason || "Message rejected by routing rule",
			};
		}
		const candidates = await sql.RoutingMailboxes`
			/* @notNull id */
			/* @notNull user_id */
			SELECT b.id,b.user_id,b.domain_id,b.local_part,b.use_all_domains,d.user_id AS domain_owner FROM mailboxes b JOIN domains d ON d.id=b.domain_id
			WHERE b.disabled=0 AND (b.domain_id=${domain.id} OR (b.use_all_domains=1 AND d.user_id=${domain.user_id}))
			ORDER BY CASE WHEN b.domain_id=${domain.id} THEN 0 ELSE 1 END,b.created_at,b.id`;
		const normalized = normalizeLocalPart(address.local);
		const exact = candidates.find(
			(mailbox) =>
				mailbox.domain_id === domain.id &&
				normalizeLocalPart(mailbox.local_part) === normalized,
		);
		if (exact) return { action: "store" as const, mailbox: exact };
		const aliases = await sql.RoutingAliases`
			/* @notNull id */
			/* @notNull user_id */
			SELECT b.id,b.user_id,b.domain_id,b.local_part,a.local_part AS alias_local_part FROM mailbox_aliases a JOIN mailboxes b ON b.id=a.mailbox_id
			WHERE a.domain_id=${domain.id} AND b.disabled=0 ORDER BY a.created_at,a.id`;
		const alias = aliases.find(
			(alias) =>
				normalizeLocalPart(alias.alias_local_part ?? "") === normalized,
		);
		if (alias) return { action: "store" as const, mailbox: alias };
		const crossDomain = candidates.find(
			(mailbox) =>
				mailbox.use_all_domains &&
				normalizeLocalPart(mailbox.local_part) === normalized,
		);
		if (crossDomain) return { action: "store" as const, mailbox: crossDomain };
		for (const rule of rules) {
			if (
				!["store", "forward"].includes(rule.action) ||
				!matchesRule(rule, { to, from, ...content })
			)
				continue;
			// Match targets are constrained to this domain's owner, including restored rules.
			const [target] = rule.mailbox_id
				? await sql.RuleTarget`
				/* @notNull id */
				/* @notNull user_id */
				SELECT b.id,b.user_id,b.domain_id,b.local_part FROM mailboxes b JOIN domains d ON d.id=b.domain_id
				WHERE b.id=${rule.mailbox_id} AND b.disabled=0 AND d.user_id=${domain.user_id}`
				: [];
			if (rule.action === "forward" && rule.forward_to) {
				await record(rule.id);
				return {
					action: "forward" as const,
					forwardTo: rule.forward_to,
					keepCopy: !!rule.keep_copy,
					mailbox: target,
				};
			}
			if (target) {
				await record(rule.id);
				return { action: "store" as const, mailbox: target };
			}
		}
		return null;
	});
}
export async function inboxDestination(
	mailboxId: string,
	input: { to: string; from: string; subject: string; content: string },
) {
	return withDatabase(async (sql) => {
		const rules =
			await sql.InboxRoutingRules`SELECT * FROM routing_rules WHERE mailbox_id=${mailboxId} AND scope='mailbox' AND enabled=1 ORDER BY priority DESC,created_at,id`;
		for (const rule of rules) {
			if (!matchesRule(rule, input)) continue;
			if (rule.action === "spam" || rule.action === "trash")
				return { status: rule.action, folderId: null };
			if (rule.folder_id) {
				const [folder] =
					await sql.RuleFolder`SELECT id FROM folders WHERE id=${rule.folder_id} AND mailbox_id=${mailboxId}`;
				if (folder) return { status: "received", folderId: folder.id };
			}
		}
		return { status: "received", folderId: null };
	});
}
