import { listMailboxes } from "./repository";
import { licenseEntitlements } from "../licenses";
import { z } from "zod";
import safeRegex from "safe-regex2";
import { withDatabase, id, seconds } from "../db";
import type { User } from "../../shared/contracts";
import { aliasSchema, ruleSchema } from "../../shared/mail-contracts";
import { mailboxAccess, managedDomain } from "./access";
import { normalizeLocalPart } from "./routing";
import { folderSchema } from "../../lib/validators";

export async function mailSettings(user: User) {
	const accessible = await listMailboxes(user),
		ids = JSON.stringify(accessible.map((box) => box.id)),
		managed = JSON.stringify(
			accessible
				.filter((box) => box.permission === "full_access")
				.map((box) => box.id),
		);
	return withDatabase(async (sql) => {
		const domains = await sql.SettingsDomains`/* @notNull id */
/* @notNull user_id */
SELECT id,hostname,user_id FROM domains WHERE user_id=${user.id} OR id IN (SELECT b.domain_id FROM mailboxes b WHERE b.id IN(SELECT value FROM json_each(${ids})))`;
		const aliases = await sql.SettingsAliases`/* @notNull id */
/* @notNull mailbox_id */
/* @notNull domain_id */
/* @notNull local_part */
SELECT a.id,a.mailbox_id,a.domain_id,a.local_part,d.hostname FROM mailbox_aliases a JOIN domains d ON d.id=a.domain_id JOIN mailboxes b ON b.id=a.mailbox_id WHERE b.id IN(SELECT value FROM json_each(${ids}))`;
		const rules = await sql.SettingsRules`/* @notNull id */
SELECT r.* FROM routing_rules r WHERE r.domain_id IN (SELECT id FROM domains WHERE user_id=${user.id}) OR (r.scope='mailbox' AND r.mailbox_id IN (SELECT value FROM json_each(${managed}))) ORDER BY r.priority DESC,r.created_at,r.id`;
		const [account] =
			await sql.SettingsForwarding`SELECT forwarding_email FROM users WHERE id=${user.id}`;
		const folders = await sql.SettingsFolders`/* @notNull id */
SELECT f.id,f.name,f.color,f.mailbox_id FROM folders f JOIN mailboxes b ON b.id=f.mailbox_id JOIN domains d ON d.id=b.domain_id WHERE b.id IN(SELECT value FROM json_each(${ids})) ORDER BY f.name`;
		return {
			domains,
			aliases,
			rules,
			folders,
			forwardingEmail: account?.forwarding_email ?? "",
		};
	});
}
export async function addAlias(user: User, input: z.infer<typeof aliasSchema>) {
	const data = aliasSchema.parse(input);
	const mailbox = await mailboxAccess(user, data.mailboxId, "manage");
	const [domain] = await withDatabase(
		(sql) =>
			sql.NativeManagedAliasDomain`SELECT id,hostname,user_id FROM domains WHERE id=${data.domainId} AND user_id=${mailbox.domain_owner} AND status='active'`,
	);
	if (!domain) throw new Response("Domain not found", { status: 404 });
	if (mailbox.domain_owner !== domain.user_id)
		throw new Error("Aliases must stay within the same domain owner");
	const normalized = normalizeLocalPart(data.localPart);
	if (!normalized) throw new Error("Enter a valid alias");
	const rows = await withDatabase(
		(sql) => sql.CreateAlias`
		INSERT INTO mailbox_aliases (id,mailbox_id,domain_id,local_part,created_at)
		SELECT ${id("alias")},${data.mailboxId},${data.domainId},${data.localPart},${seconds()}
		WHERE NOT EXISTS (SELECT 1 FROM mailboxes WHERE domain_id=${data.domainId} AND replace(lower(substr(local_part,1,instr(local_part||'+','+')-1)),'.','')=${normalized})
		AND NOT EXISTS (SELECT 1 FROM mailbox_aliases WHERE domain_id=${data.domainId} AND replace(lower(substr(local_part,1,instr(local_part||'+','+')-1)),'.','')=${normalized}) RETURNING id`,
	);
	if (!rows.length) throw new Error("This address is already assigned");
	return { id: rows[0]?.id };
}
export async function removeAlias(user: User, aliasId: string) {
	const [alias] = await withDatabase(
		(sql) =>
			sql.FindAlias`SELECT mailbox_id FROM mailbox_aliases WHERE id=${aliasId}`,
	);
	if (!alias) throw new Error("Alias not found");
	await mailboxAccess(user, alias.mailbox_id, "manage");
	await withDatabase(
		(sql) => sql.RemoveAlias`DELETE FROM mailbox_aliases WHERE id=${aliasId}`,
	);
}
export async function setDomainAliases(
	user: User,
	mailboxId: string,
	enabled: boolean,
) {
	await mailboxAccess(user, mailboxId, "manage");
	await withDatabase(
		(sql) =>
			sql.SetAllDomains`UPDATE mailboxes SET use_all_domains=${enabled ? 1 : 0} WHERE id=${mailboxId}`,
	);
}
export async function setForwarding(user: User, email: string) {
	if (!(await licenseEntitlements()).canForwardEmail)
		throw new Response(
			"A Pro or Team license is required for email forwarding",
			{ status: 403 },
		);
	const value = z.email().or(z.literal("")).parse(email.trim().toLowerCase());
	if (value === user.email.toLowerCase())
		throw new Error("Forwarding destination must differ from your own address");
	await withDatabase(
		(sql) =>
			sql.SetForwarding`UPDATE users SET forwarding_email=${value || null} WHERE id=${user.id}`,
	);
}
export async function saveRule(user: User, input: z.infer<typeof ruleSchema>) {
	const data = ruleSchema.parse(input);
	if (data.scope === "domain") {
		if (user.role !== "admin") throw new Error("Administrator access required");
		await managedDomain(user, data.domainId);
		if (!["store", "forward", "reject"].includes(data.action))
			throw new Error("Domain rules use store/forward/reject actions");
	} else {
		if (!data.mailboxId) throw new Error("Select a mailbox");
		const mailbox = await mailboxAccess(user, data.mailboxId, "manage");
		if (
			mailbox.domain_id !== data.domainId ||
			!["store", "spam", "trash"].includes(data.action)
		)
			throw new Error("Invalid mailbox rule");
		if (data.action === "store" && !data.folderId)
			throw new Error("Select a destination folder");
	}
	if (data.matchOperator === "regex" && !safeRegex(data.matchValue))
		throw new Error("Invalid or unsafe regular expression");
	if (data.action === "forward" && !data.forwardTo)
		throw new Error("Forwarding destination is required");
	if ((data.action === "store" || data.keepCopy) && !data.mailboxId)
		throw new Error("Select a destination mailbox");
	if (data.mailboxId) {
		const mailbox = await mailboxAccess(user, data.mailboxId, "manage");
		if (mailbox.domain_id !== data.domainId)
			throw new Error("Destination mailbox must belong to this domain");
	}
	if (data.folderId) {
		const [folder] = await withDatabase(
			(sql) =>
				sql.ManagedRuleFolder`SELECT id FROM folders WHERE id=${data.folderId} AND mailbox_id=${data.mailboxId}`,
		);
		if (!folder) throw new Error("Folder not found");
	}
	if (data.id) {
		const [existing] = await withDatabase(
			(sql) =>
				sql.ExistingRule`SELECT id,domain_id,scope,mailbox_id FROM routing_rules WHERE id=${data.id}`,
		);
		if (
			!existing ||
			existing.domain_id !== data.domainId ||
			existing.scope !== data.scope ||
			(data.scope === "mailbox" && existing.mailbox_id !== data.mailboxId)
		)
			throw new Error("Rule not found");
	}
	const ruleId = data.id ?? id("rule");
	await withDatabase(
		(sql) => sql.UpsertRoutingRule`
		INSERT INTO routing_rules (id,user_id,domain_id,scope,name,enabled,pattern,match_field,match_operator,match_value,action,mailbox_id,folder_id,forward_to,keep_copy,reject_reason,priority,created_at)
		VALUES (${ruleId},${user.id},${data.domainId},${data.scope},${data.name},${data.enabled ? 1 : 0},${data.matchValue},${data.matchField},${data.matchOperator},${data.matchValue},${data.action},${data.mailboxId ?? null},${data.folderId ?? null},${data.forwardTo || null},${data.keepCopy ? 1 : 0},${data.rejectReason || null},${data.priority},${seconds()})
		ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,pattern=excluded.pattern,match_field=excluded.match_field,match_operator=excluded.match_operator,match_value=excluded.match_value,action=excluded.action,mailbox_id=excluded.mailbox_id,folder_id=excluded.folder_id,forward_to=excluded.forward_to,keep_copy=excluded.keep_copy,reject_reason=excluded.reject_reason,priority=excluded.priority`,
	);
	return { id: ruleId };
}
export async function createFolder(
	user: User,
	input: { mailboxId: string; name: string; color?: string },
) {
	const data = folderSchema.parse(input),
		name = data.name,
		color = data.color;
	const mailbox = await mailboxAccess(user, data.mailboxId, "manage");
	const folderId = id("folder");
	const created = await withDatabase(
		(sql) => sql.CreateCustomFolder`
 INSERT INTO folders (id,user_id,mailbox_id,name,color,created_at)
 SELECT ${folderId},${mailbox.user_id},${data.mailboxId},${name},${color},${seconds()}
 WHERE NOT EXISTS(SELECT 1 FROM folders WHERE mailbox_id=${data.mailboxId} AND name=${name}) RETURNING id`,
	);
	if (!created.length) throw new Error("Folder already exists");
	return { id: folderId, mailboxId: data.mailboxId, name, color };
}
export async function removeRule(user: User, ruleId: string) {
	const [rule] = await withDatabase(
		(sql) =>
			sql.RemovableRule`SELECT domain_id,scope,mailbox_id FROM routing_rules WHERE id=${ruleId}`,
	);
	if (!rule) throw new Error("Rule not found");
	if (rule.scope === "domain") {
		if (user.role !== "admin") throw new Error("Administrator access required");
		await managedDomain(user, rule.domain_id);
	} else {
		if (!rule.mailbox_id) throw new Error("Invalid rule");
		await mailboxAccess(user, rule.mailbox_id, "manage");
	}
	await withDatabase(
		(sql) =>
			sql.DeleteRoutingRule`DELETE FROM routing_rules WHERE id=${ruleId}`,
	);
}
