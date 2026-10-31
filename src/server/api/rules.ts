import { z } from "zod";
import safeRegex from "safe-regex2";
import { withDatabase, id, seconds } from "../db";
import type { User } from "../../shared/contracts";
import { mailboxAccess, managedDomain } from "../mail/access";
import { listMailboxes } from "../mail/repository";
import { saveRule, removeRule } from "../mail/management";
import {
	routingRuleSchema,
	domainRoutingRuleSchema,
} from "../../lib/validators";
import { readLimitedBody } from "../mail/inbound";
import { iso } from "../mail/message-query";
export async function rulesApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	const url = new URL(request.url),
		path = url.pathname,
		method = request.method;
	const match = /^\/api\/routing-rules(?:\/(domain))?(?:\/([^/]+))?$/.exec(
		path,
	);
	if (!match) return null;
	const domainScope = match[1] === "domain",
		ruleId = match[2] ? decodeURIComponent(match[2]) : undefined;
	const read = async (): Promise<unknown> =>
		JSON.parse(
			new TextDecoder().decode(await readLimitedBody(request, 16 * 1024)),
		);
	const json = (value: unknown) => Response.json(value);
	if (!domainScope) {
		if (method === "GET" && !ruleId) {
			const mailboxId = url.searchParams.get("mailboxId");
			if (!mailboxId) return json({ rules: [] });
			await mailboxAccess(user, mailboxId, "manage");
			const rows = await withDatabase(
				(sql) =>
					sql.NativeInboxRules`SELECT * FROM routing_rules WHERE mailbox_id=${mailboxId} AND scope='mailbox' ORDER BY priority DESC,created_at,id`,
			);
			return json({
				rules: rows.map((row) => ({
					id: row.id,
					userId: row.user_id,
					domainId: row.domain_id,
					pattern: row.pattern,
					mailboxId: row.mailbox_id,
					action: row.action,
					forwardTo: row.forward_to,
					priority: row.priority,
					createdAt: iso(row.created_at),
					folderId: row.folder_id,
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
				})),
			});
		}
		if ((method === "POST" && !ruleId) || (method === "PATCH" && ruleId)) {
			const data = routingRuleSchema.parse(await read()),
				box = await mailboxAccess(user, data.mailboxId, "manage");
			const destination =
				data.destination ?? (data.folderId ? "folder:" + data.folderId : "");
			const folderId = destination.startsWith("folder:")
				? destination.slice(7)
				: null;
			if (!folderId && destination !== "spam" && destination !== "trash")
				throw new Response("Destination is required", { status: 400 });
			return json(
				await saveRule(user, {
					id: ruleId,
					domainId: box.domain_id,
					scope: "mailbox",
					name: "",
					enabled: true,
					forwardTo: "",
					keepCopy: false,
					rejectReason: "",
					mailboxId: box.id,
					matchField: data.matchField,
					matchOperator: data.matchOperator,
					matchValue: data.matchValue,
					action:
						destination === "spam"
							? "spam"
							: destination === "trash"
								? "trash"
								: "store",
					folderId,
					priority: data.priority,
				}),
			);
		}
		if (method === "DELETE" && ruleId) {
			const [row] = await withDatabase(
				(sql) =>
					sql.NativeInboxRuleGuard`SELECT scope FROM routing_rules WHERE id=${ruleId}`,
			);
			if (!row || row.scope !== "mailbox")
				throw new Response("Rule not found", { status: 404 });
			await removeRule(user, ruleId);
			return json({ ok: true });
		}
		return null;
	}
	const existing = ruleId
		? await withDatabase(
				async (sql) =>
					(
						await sql.NativeDomainRuleGuard`SELECT id,domain_id FROM routing_rules WHERE id=${ruleId} AND scope='domain'`
					)[0],
			)
		: undefined;
	if (ruleId && !existing)
		throw new Response("Rule not found", { status: 404 });
	const input =
		method === "POST" || method === "PATCH"
			? domainRoutingRuleSchema.parse(await read())
			: undefined;
	const domainId =
		existing?.domain_id ?? input?.domainId ?? url.searchParams.get("domainId");
	if (!domainId) throw new Response("domainId is required", { status: 400 });
	if (input && input.domainId !== domainId)
		throw new Response("Rule domain cannot be changed", { status: 400 });
	const sourceMailbox = url.searchParams.get("mailboxId");
	let admin = false;
	if (sourceMailbox) {
		const access = await mailboxAccess(user, sourceMailbox, "manage");
		if (access.domain_id !== domainId)
			throw new Response("Domain or mailbox access is required", {
				status: 403,
			});
	} else {
		if (user.role !== "admin") throw new Response("Forbidden", { status: 403 });
		await managedDomain(user, domainId);
		admin = true;
	}
	const boxes = admin
		? await withDatabase(
				(sql) =>
					sql.NativeAdminRuleMailboxes`SELECT id,local_part,display_name FROM mailboxes WHERE domain_id=${domainId} AND disabled=0`,
			)
		: (await listMailboxes(user)).filter(
				(box) => box.domain_id === domainId && box.permission === "full_access",
			);
	if (method === "GET") {
		const rows = await withDatabase(
			(sql) =>
				sql.NativeDomainRules`SELECT * FROM routing_rules WHERE domain_id=${domainId} AND scope='domain' ORDER BY priority DESC,created_at,id`,
		);
		return json({
			rules: rows.map((row) => ({
				id: row.id,
				domainId: row.domain_id,
				name: row.name,
				enabled: !!row.enabled,
				matchField: row.match_field,
				matchOperator: row.match_operator,
				matchValue: row.match_value,
				action: row.action,
				mailboxId: row.mailbox_id,
				forwardTo: row.forward_to,
				keepCopy: !!row.keep_copy,
				rejectReason: row.reject_reason,
				priority: row.priority,
				matchCount: row.match_count,
				lastMatchedAt: iso(row.last_matched_at),
				createdAt: iso(row.created_at),
			})),
			mailboxes: boxes.map((box) => ({
				id: box.id,
				localPart: box.local_part,
				displayName: box.display_name,
			})),
		});
	}
	if (input) {
		if (input.matchOperator === "regex" && !safeRegex(input.matchValue))
			throw new Response("Invalid or unsafe regular expression", {
				status: 400,
			});
		if (input.mailboxId && !boxes.some((box) => box.id === input.mailboxId))
			throw new Response("Mailbox access is required for the destination", {
				status: 403,
			});
		const key = ruleId ?? id("rule");
		await withDatabase(
			(sql) =>
				sql.NativeSaveDomainRule`INSERT INTO routing_rules (id,user_id,domain_id,scope,name,enabled,pattern,match_field,match_operator,match_value,action,mailbox_id,forward_to,keep_copy,reject_reason,priority,created_at) VALUES (${key},${user.id},${domainId},'domain',${input.name ?? ""},${input.enabled ? 1 : 0},${input.matchValue},${input.matchField},${input.matchOperator},${input.matchValue},${input.action},${input.mailboxId ?? null},${input.forwardTo || null},${input.keepCopy ? 1 : 0},${input.rejectReason || null},${input.priority},${seconds()}) ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,pattern=excluded.pattern,match_field=excluded.match_field,match_operator=excluded.match_operator,match_value=excluded.match_value,action=excluded.action,mailbox_id=excluded.mailbox_id,forward_to=excluded.forward_to,keep_copy=excluded.keep_copy,reject_reason=excluded.reject_reason,priority=excluded.priority`,
		);
		return json({ id: key });
	}
	if (method === "DELETE" && ruleId) {
		await withDatabase(
			(sql) =>
				sql.NativeDeleteDomainRule`DELETE FROM routing_rules WHERE id=${ruleId} AND domain_id=${domainId} AND scope='domain'`,
		);
		return json({ ok: true });
	}
	return null;
}
