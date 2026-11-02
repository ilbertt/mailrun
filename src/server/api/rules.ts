import { z } from "zod";
import { withDatabase, id, seconds, type AppSQL } from "../db";
import type { User } from "../../shared/contracts";
import type { Queries } from "../../queries.gen";
import { mailboxAccess, MailboxAccessError } from "../mail/access";
import {
	routingRuleSchema,
	domainRoutingRuleSchema,
} from "../../lib/validators";
import { readLimitedBody } from "../mail/inbound";
import { iso } from "../mail/message-query";

const json = (value: unknown, status = 200) => Response.json(value, { status });
function ruleDto(row: Queries["NativeInboxRules"]) {
	return {
		id: row.id,
		userId: row.user_id,
		domainId: row.domain_id,
		pattern: row.pattern,
		mailboxId: row.mailbox_id,
		folderId: row.folder_id,
		action: row.action,
		forwardTo: row.forward_to,
		priority: row.priority,
		createdAt: iso(row.created_at),
		matchField: row.match_field,
		matchOperator: row.match_operator,
		matchValue: row.match_value,
		scope: row.scope,
		name: row.name,
		enabled: !!row.enabled,
		keepCopy: !!row.keep_copy,
		rejectReason: row.reject_reason,
		lastMatchedAt: iso(row.last_matched_at),
		matchCount: row.match_count,
	};
}
async function managedMailbox(
	sql: AppSQL,
	user: User,
	mailboxId: string,
	error: string,
) {
	try {
		return await mailboxAccess(user, mailboxId, "manage", sql);
	} catch (cause) {
		if (cause instanceof MailboxAccessError)
			throw new Response(error, { status: 404 });
		throw cause;
	}
}
async function inboxDestination(
	sql: AppSQL,
	data: z.infer<typeof routingRuleSchema>,
	mailboxId: string,
) {
	const destination =
		data.destination ?? (data.folderId ? "folder:" + data.folderId : "");
	const folderId = destination.startsWith("folder:")
		? destination.slice(7)
		: null;
	const action =
		destination === "spam"
			? "spam"
			: destination === "trash"
				? "trash"
				: "store";
	if (action === "store" && !folderId)
		throw new Response("Destination is required", { status: 400 });
	if (folderId) {
		const [folder] =
			await sql.SourceRoutingFolder`SELECT id FROM folders WHERE id=${folderId} AND mailbox_id=${mailboxId}`;
		if (!folder) throw new Response("Folder not found", { status: 404 });
	}
	return { action, folderId };
}
async function domainAccess(
	sql: AppSQL,
	user: User,
	domainId: string,
	contextMailbox: string | null,
) {
	if (!contextMailbox) {
		const [admin] =
			await sql.SourceRoutingAdminDomain`SELECT d.id FROM domains d JOIN users u ON u.id=${user.id} WHERE d.id=${domainId} AND u.role='admin' AND u.disabled=0 AND d.user_id=CASE WHEN u.can_manage_mailboxes=1 AND coalesce(u.created_by_user_id,'')!='' THEN u.created_by_user_id ELSE u.id END`;
		if (admin) return true;
	} else {
		try {
			const box = await mailboxAccess(user, contextMailbox, "manage", sql);
			if (box.domain_id === domainId) return false;
		} catch (cause) {
			if (!(cause instanceof MailboxAccessError)) throw cause;
		}
	}
	throw new Response("Domain or mailbox access is required", { status: 403 });
}
async function loadDomainRule(
	sql: AppSQL,
	user: User,
	ruleId: string,
	contextMailbox: string | null,
) {
	const [rule] =
		await sql.NativeDomainRuleGuard`SELECT * FROM routing_rules WHERE id=${ruleId} AND scope='domain'`;
	if (!rule) throw new Response("Rule not found", { status: 404 });
	const admin = await domainAccess(sql, user, rule.domain_id, contextMailbox);
	return { rule, admin };
}
async function destinationAccess(
	sql: AppSQL,
	user: User,
	data: z.infer<typeof domainRoutingRuleSchema>,
	admin: boolean,
) {
	if (!data.mailboxId) return;
	if (admin) {
		const [box] =
			await sql.SourceAdminRuleDestination`SELECT id FROM mailboxes WHERE id=${data.mailboxId} AND domain_id=${data.domainId}`;
		if (box) return;
	} else {
		try {
			const box = await mailboxAccess(user, data.mailboxId, "manage", sql);
			if (box.domain_id === data.domainId) return;
		} catch (cause) {
			if (!(cause instanceof MailboxAccessError)) throw cause;
		}
	}
	throw new Response("Mailbox access is required for the destination", {
		status: 403,
	});
}
function domainColumns(data: z.infer<typeof domainRoutingRuleSchema>) {
	return {
		name: data.name?.trim() || null,
		enabled: data.enabled ? 1 : 0,
		mailboxId: data.action === "reject" ? null : (data.mailboxId ?? null),
		forwardTo:
			data.action === "forward" ? (data.forwardTo?.trim() ?? null) : null,
		keepCopy: data.action === "forward" && data.keepCopy ? 1 : 0,
		rejectReason:
			data.action === "reject" ? data.rejectReason?.trim() || null : null,
	};
}
async function saveDomainRule(
	sql: AppSQL,
	user: User,
	data: z.infer<typeof domainRoutingRuleSchema>,
	admin: boolean,
	ruleId?: string,
) {
	await destinationAccess(sql, user, data, admin);
	const columns = domainColumns(data);
	if (ruleId) {
		await sql.SourceUpdateDomainRule`UPDATE routing_rules SET scope='domain',name=${columns.name},enabled=${columns.enabled},pattern=${data.matchValue},match_field=${data.matchField},match_operator=${data.matchOperator},match_value=${data.matchValue},action=${data.action},mailbox_id=${columns.mailboxId},folder_id=NULL,forward_to=${columns.forwardTo},keep_copy=${columns.keepCopy},reject_reason=${columns.rejectReason},priority=${data.priority} WHERE id=${ruleId}`;
		return json({ ok: true });
	}
	const key = id("rule");
	await sql.SourceCreateDomainRule`INSERT INTO routing_rules(id,user_id,domain_id,scope,name,enabled,pattern,match_field,match_operator,match_value,action,mailbox_id,folder_id,forward_to,keep_copy,reject_reason,priority,created_at) VALUES(${key},${user.id},${data.domainId},'domain',${columns.name},${columns.enabled},${data.matchValue},${data.matchField},${data.matchOperator},${data.matchValue},${data.action},${columns.mailboxId},NULL,${columns.forwardTo},${columns.keepCopy},${columns.rejectReason},${data.priority},${seconds()})`;
	return json({ id: key });
}
export async function rulesApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	const url = new URL(request.url),
		method = request.method,
		match = /^\/api\/routing-rules(?:\/(domain))?(?:\/([^/]+))?$/.exec(
			url.pathname,
		);
	if (!match) return null;
	const domainScope = match[1] === "domain",
		ruleId = match[2] ? decodeURIComponent(match[2]) : undefined;
	const read = async (): Promise<unknown> =>
		JSON.parse(
			new TextDecoder().decode(await readLimitedBody(request, 16 * 1024)),
		);
	if (!domainScope) {
		if (method === "GET" && !ruleId) {
			const mailboxId = url.searchParams.get("mailboxId");
			if (!mailboxId) return json({ rules: [] });
			return withDatabase(async (sql) => {
				await managedMailbox(sql, user, mailboxId, "Mailbox not found");
				const rows =
					await sql.NativeInboxRules`SELECT * FROM routing_rules WHERE mailbox_id=${mailboxId} AND scope='mailbox' ORDER BY rowid`;
				return json({ rules: rows.map(ruleDto) });
			});
		}
		if ((method === "POST" && !ruleId) || (method === "PATCH" && ruleId)) {
			const parsed = routingRuleSchema.safeParse(await read());
			if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
			const data = parsed.data;
			return withDatabase((sql) =>
				sql.begin(async (sql) => {
					if (ruleId) {
						const [rule] =
							await sql.SourceMutableInboxRule`SELECT mailbox_id FROM routing_rules WHERE id=${ruleId}`;
						if (!rule?.mailbox_id || rule.mailbox_id !== data.mailboxId)
							throw new Response("Rule not found", { status: 404 });
					}
					const box = await managedMailbox(
						sql,
						user,
						data.mailboxId,
						ruleId ? "Rule not found" : "Mailbox not found",
					);
					const target = await inboxDestination(sql, data, box.id);
					if (ruleId) {
						await sql.SourceUpdateInboxRule`UPDATE routing_rules SET pattern=${data.matchValue.trim()},match_field=${data.matchField},match_operator=${data.matchOperator},match_value=${data.matchValue.trim()},action=${target.action},folder_id=${target.folderId},forward_to=NULL,priority=${data.priority} WHERE id=${ruleId}`;
						return json({ ok: true });
					}
					const key = id("rule");
					await sql.SourceCreateInboxRule`INSERT INTO routing_rules(id,user_id,domain_id,scope,pattern,match_field,match_operator,match_value,action,mailbox_id,folder_id,forward_to,priority,created_at) VALUES(${key},${user.id},${box.domain_id},'mailbox',${data.matchValue.trim()},${data.matchField},${data.matchOperator},${data.matchValue.trim()},${target.action},${box.id},${target.folderId},NULL,${data.priority},${seconds()})`;
					return json({ id: key, ...data });
				}),
			);
		}
		if (method === "DELETE" && ruleId)
			return withDatabase((sql) =>
				sql.begin(async (sql) => {
					const [rule] =
						await sql.SourceDeletableInboxRule`SELECT mailbox_id FROM routing_rules WHERE id=${ruleId}`;
					if (!rule?.mailbox_id)
						throw new Response("Rule not found", { status: 404 });
					await managedMailbox(sql, user, rule.mailbox_id, "Rule not found");
					await sql.SourceDeleteInboxRule`DELETE FROM routing_rules WHERE id=${ruleId}`;
					return json({ ok: true });
				}),
			);
		return null;
	}
	const contextMailbox = url.searchParams.get("mailboxId");
	if (method === "GET" && !ruleId) {
		const domainId = url.searchParams.get("domainId");
		if (!domainId) throw new Response("domainId is required", { status: 400 });
		return withDatabase(async (sql) => {
			const admin = await domainAccess(sql, user, domainId, contextMailbox);
			const rows =
				await sql.NativeDomainRules`SELECT * FROM routing_rules WHERE domain_id=${domainId} AND scope='domain' ORDER BY priority DESC,created_at,rowid`;
			const boxes = admin
				? await sql.NativeAdminRuleMailboxes`SELECT id,local_part,display_name,disabled FROM mailboxes WHERE domain_id=${domainId} ORDER BY local_part`
				: await sql.SourceManagedRuleMailboxes`SELECT b.id,b.local_part,b.display_name,b.disabled FROM mailboxes b WHERE b.domain_id=${domainId} AND b.disabled=0 AND (b.user_id=${user.id} OR (b.type='shared' AND EXISTS(SELECT 1 FROM license_settings WHERE id='default' AND plan='team' AND state='active') AND EXISTS(SELECT 1 FROM mailbox_access WHERE mailbox_id=b.id AND user_id=${user.id} AND permission='full_access')))`;
			if (!admin)
				boxes.sort((a, b) => a.local_part.localeCompare(b.local_part));
			return json({
				rules: rows.map(ruleDto),
				mailboxes: boxes.map((box) => ({
					id: box.id,
					localPart: box.local_part,
					displayName: box.display_name,
					disabled: !!box.disabled,
				})),
			});
		});
	}
	if (method === "POST" && !ruleId) {
		const parsed = domainRoutingRuleSchema.safeParse(await read());
		if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
		return withDatabase((sql) =>
			sql.begin(async (sql) => {
				const admin = await domainAccess(
					sql,
					user,
					parsed.data.domainId,
					contextMailbox,
				);
				return saveDomainRule(sql, user, parsed.data, admin);
			}),
		);
	}
	if (method === "PATCH" && ruleId) {
		// Preserve authorization-before-body semantics without holding SQLite's queue
		// while waiting for request bytes, then recheck live grants inside the write.
		await withDatabase((sql) =>
			loadDomainRule(sql, user, ruleId, contextMailbox),
		);
		const input = await read();
		const fields = z.record(z.string(), z.unknown()).safeParse(input);
		return withDatabase((sql) =>
			sql.begin(async (sql) => {
				const { rule, admin } = await loadDomainRule(
					sql,
					user,
					ruleId,
					contextMailbox,
				);
				const parsed = domainRoutingRuleSchema.safeParse({
					...(fields.success ? fields.data : {}),
					domainId: rule.domain_id,
				});
				if (!parsed.success)
					return json({ error: parsed.error.flatten() }, 400);
				return saveDomainRule(sql, user, parsed.data, admin, ruleId);
			}),
		);
	}
	if (method === "DELETE" && ruleId)
		return withDatabase((sql) =>
			sql.begin(async (sql) => {
				await loadDomainRule(sql, user, ruleId, contextMailbox);
				await sql.NativeDeleteDomainRule`DELETE FROM routing_rules WHERE id=${ruleId} AND scope='domain'`;
				return json({ ok: true });
			}),
		);
	return null;
}
