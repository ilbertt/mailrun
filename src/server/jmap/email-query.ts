import { normalizeMessageId } from "../../lib/email/threading";
import { withDatabase } from "../db";
import { scopeIds } from "./repository";
import { decodeMailboxRef, roleToStatus } from "./ids";
import { invalidArguments, unsupportedFilter } from "./errors";
import type { JmapContext, MailboxRef } from "./types";
type Leaf = Record<string, unknown>;
type Instruction =
	| { op: "leaf"; test: Leaf }
	| { op: "AND" | "OR" | "NOT"; count: number };
const record = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw invalidArguments("Expected a filter object");
	return value as Record<string, unknown>;
};
const pattern = (value: unknown) => {
	if (typeof value !== "string")
		throw invalidArguments("Filter text must be a string");
	return `%${value.replace(/[%_!]/g, "!$&")}%`;
};
function ref(value: unknown, accessible: Set<string>, required = false) {
	const decoded = typeof value === "string" ? decodeMailboxRef(value) : null;
	if (!decoded || !accessible.has(decoded.mailboxId)) {
		if (required) throw invalidArguments(`Unknown mailbox ${String(value)}`);
		return null;
	}
	return {
		...decoded,
		...(decoded.kind === "role" ? { status: roleToStatus(decoded.role) } : {}),
	};
}
export function compileFilter(
	value: unknown,
	accessible: Set<string>,
): Instruction[] {
	const walk = (value: unknown, depth = 0): Instruction[] | undefined => {
		if (value == null) return undefined;
		if (depth > 1000) throw invalidArguments("Filter nesting is too deep");
		const filter = record(value);
		if ("operator" in filter) {
			if (!["AND", "OR", "NOT"].includes(String(filter.operator)))
				throw invalidArguments("Unknown filter operator");
			if (!Array.isArray(filter.conditions))
				throw invalidArguments("conditions must be an array");
			const children = filter.conditions
				.map((child) => walk(child, depth + 1))
				.filter((child): child is Instruction[] => !!child);
			return children.length
				? [
						...children.flat(),
						{
							op: filter.operator as "AND" | "OR" | "NOT",
							count: children.length,
						},
					]
				: undefined;
		}
		const test: Leaf = {};
		if (filter.inMailbox !== undefined)
			test.in = ref(filter.inMailbox, accessible, true);
		if (filter.inMailboxOtherThan) {
			if (!Array.isArray(filter.inMailboxOtherThan))
				throw invalidArguments("inMailboxOtherThan must be an array");
			const items = filter.inMailboxOtherThan
				.map((id) => ref(id, accessible))
				.filter(Boolean);
			if (items.length) test.excluded = items;
		}
		for (const key of ["before", "after"])
			if (filter[key]) {
				const date = new Date(String(filter[key]));
				if (!Number.isFinite(date.getTime()))
					throw invalidArguments(`Invalid ${key} date`);
				test[key] = Math.floor(date.getTime() / 1000);
			}
		const keywords: { name: string; present: boolean }[] = [];
		for (const [key, present] of [
			["hasKeyword", true],
			["notKeyword", false],
			["someInThreadHaveKeyword", true],
			["allInThreadHaveKeyword", true],
			["noneInThreadHaveKeyword", false],
		] as const)
			if (filter[key]) {
				if (typeof filter[key] !== "string")
					throw invalidArguments("Invalid keyword");
				keywords.push({ name: filter[key], present });
			}
		if (keywords.length) test.keywords = keywords;
		for (const key of ["from", "to", "cc", "bcc", "subject", "body", "text"])
			if (filter[key]) test[key] = pattern(filter[key]);
		if (filter.header) {
			if (
				!Array.isArray(filter.header) ||
				filter.header.length < 1 ||
				filter.header.length > 2 ||
				typeof filter.header[0] !== "string"
			)
				throw invalidArguments("header must be [name] or [name, value]");
			const name = filter.header[0].trim().toLowerCase();
			if (!["message-id", "in-reply-to", "references"].includes(name))
				throw unsupportedFilter(
					`Cannot filter on the ${filter.header[0]} header`,
				);
			const value =
				filter.header.length === 2
					? normalizeMessageId(String(filter.header[1]))
					: null;
			test.header = {
				name,
				exists: filter.header.length === 1,
				value,
				pattern: value ? pattern(` ${value} `) : null,
			};
		}
		if (filter.hasAttachment !== undefined) {
			if (typeof filter.hasAttachment !== "boolean")
				throw invalidArguments("hasAttachment must be boolean");
			test.hasAttachment = filter.hasAttachment;
		}
		for (const key of ["minSize", "maxSize"])
			if (filter[key] !== undefined) {
				if (typeof filter[key] !== "number" || !Number.isFinite(filter[key]))
					throw invalidArguments("Invalid size");
				test[key] = filter[key];
			}
		return Object.keys(test).length ? [{ op: "leaf", test }] : undefined;
	};
	return walk(value) ?? [{ op: "leaf", test: {} }];
}
export function compileSort(value: unknown) {
	if (value != null && !Array.isArray(value))
		throw invalidArguments("sort must be an array");
	const items =
			Array.isArray(value) && value.length
				? value
				: [{ property: "receivedAt", isAscending: false }],
		seen = new Set<string>(),
		result: { column: string; asc: boolean }[] = [];
	for (const item of items) {
		const data = record(item),
			name = String(data.property),
			column =
				name === "receivedAt" || name === "sentAt"
					? "created_at"
					: name === "subject"
						? "subject"
						: name === "from"
							? "from_addr"
							: name === "to"
								? "to_addr"
								: name === "size"
									? "size"
									: [
												"hasKeyword",
												"allInThreadHaveKeyword",
												"someInThreadHaveKeyword",
											].includes(name)
										? data.keyword === "$flagged"
											? "starred"
											: "read"
										: null;
		if (!column) throw invalidArguments(`Cannot sort by ${name}`);
		if (!seen.has(column)) {
			seen.add(column);
			result.push({ column, asc: !!data.isAscending });
		}
	}
	return result;
}
export async function queryEmailIds(
	ctx: JmapContext,
	args: Record<string, unknown>,
) {
	const ids = await scopeIds(ctx),
		fallback = !ids.length && !ctx.auth.mailboxIds,
		program = JSON.stringify(compileFilter(args.filter, new Set(ids))),
		sort = JSON.stringify(compileSort(args.sort));
	const rows = await withDatabase(
		(sql) => sql.NativeJmapEmailQuery`
/* @notNull id */
/* @type thread string */
WITH program AS MATERIALIZED (SELECT CAST(key AS INTEGER) AS n,json_extract(value,'$.count') AS count,json_extract(value,'$.op') AS op,json_extract(value,'$.test.after') AS test_after,json_extract(value,'$.test.bcc') AS test_bcc,json_extract(value,'$.test.before') AS test_before,json_extract(value,'$.test.body') AS test_body,json_extract(value,'$.test.cc') AS test_cc,json_extract(value,'$.test.excluded') AS test_excluded,json_extract(value,'$.test.from') AS test_from,json_extract(value,'$.test.hasAttachment') AS test_hasAttachment,json_extract(value,'$.test.header') AS test_header,json_extract(value,'$.test.header.exists') AS test_header_exists,json_extract(value,'$.test.header.name') AS test_header_name,json_extract(value,'$.test.header.pattern') AS test_header_pattern,json_extract(value,'$.test.header.value') AS test_header_value,json_extract(value,'$.test.in') AS test_in,json_extract(value,'$.test.in.folderId') AS test_in_folderId,json_extract(value,'$.test.in.kind') AS test_in_kind,json_extract(value,'$.test.in.mailboxId') AS test_in_mailboxId,json_extract(value,'$.test.in.role') AS test_in_role,json_extract(value,'$.test.in.status') AS test_in_status,json_extract(value,'$.test.keywords') AS test_keywords,json_extract(value,'$.test.maxSize') AS test_maxSize,json_extract(value,'$.test.minSize') AS test_minSize,json_extract(value,'$.test.subject') AS test_subject,json_extract(value,'$.test.text') AS test_text,json_extract(value,'$.test.to') AS test_to FROM json_each(${program}))
SELECT m.id,coalesce(m.thread_id,m.id) AS thread FROM messages m
WHERE (m.mailbox_id IN(SELECT value FROM json_each(${JSON.stringify(ids)})) OR (${fallback ? 1 : 0}=1 AND m.user_id=${ctx.auth.userId}))
AND (m.status!='draft' OR m.user_id=${ctx.auth.userId})
AND (WITH RECURSIVE eval(step,stack) AS(
 SELECT 0,json_array()
 UNION ALL SELECT e.step+1,
 CASE p.op WHEN 'leaf' THEN json_insert(e.stack,'$[#]',
 (
(p.test_in IS NULL OR (m.mailbox_id=p.test_in_mailboxId AND CASE p.test_in_kind WHEN 'account' THEN 1 WHEN 'folder' THEN m.folder_id=p.test_in_folderId ELSE m.folder_id IS NULL AND CASE WHEN p.test_in_role='sent' THEN m.status IN('sent','queued','failed') ELSE m.status=p.test_in_status END END))
 AND NOT EXISTS(SELECT 1 FROM json_each(p.test_excluded) r WHERE (m.mailbox_id=json_extract(r.value,'$.mailboxId') AND CASE json_extract(r.value,'$.kind') WHEN 'account' THEN 1 WHEN 'folder' THEN m.folder_id=json_extract(r.value,'$.folderId') ELSE m.folder_id IS NULL AND CASE WHEN json_extract(r.value,'$.role')='sent' THEN m.status IN('sent','queued','failed') ELSE m.status=json_extract(r.value,'$.status') END END))
 AND (p.test_before IS NULL OR m.created_at<p.test_before)
 AND (p.test_after IS NULL OR m.created_at>=p.test_after)
 AND NOT EXISTS(SELECT 1 FROM json_each(p.test_keywords) k WHERE (CASE json_extract(k.value,'$.name') WHEN '$seen' THEN (m.read=1 OR m.direction='outbound') WHEN '$flagged' THEN m.starred=1 WHEN '$draft' THEN m.status='draft' ELSE 0 END)!=json_extract(k.value,'$.present'))
 AND (p.test_from IS NULL OR m.from_addr LIKE p.test_from ESCAPE '!')
 AND (p.test_to IS NULL OR m.to_addr LIKE p.test_to ESCAPE '!')
 AND (p.test_cc IS NULL OR m.cc_addr LIKE p.test_cc ESCAPE '!')
 AND (p.test_bcc IS NULL OR m.bcc_addr LIKE p.test_bcc ESCAPE '!')
 AND (p.test_subject IS NULL OR m.subject LIKE p.test_subject ESCAPE '!')
 AND (p.test_body IS NULL OR m.text_body LIKE p.test_body ESCAPE '!' OR m.html_body LIKE p.test_body ESCAPE '!')
 AND (p.test_text IS NULL OR m.subject LIKE p.test_text ESCAPE '!' OR m.from_addr LIKE p.test_text ESCAPE '!' OR m.to_addr LIKE p.test_text ESCAPE '!' OR m.cc_addr LIKE p.test_text ESCAPE '!' OR m.text_body LIKE p.test_text ESCAPE '!' OR m.snippet LIKE p.test_text ESCAPE '!')
 AND (p.test_hasAttachment IS NULL OR p.test_hasAttachment=EXISTS(SELECT 1 FROM message_attachments a WHERE a.message_id=m.id AND a.disposition='attachment' AND a.trashed_at IS NULL))
 AND (p.test_minSize IS NULL OR length(coalesce(m.text_body,''))+length(coalesce(m.html_body,''))>=p.test_minSize)
 AND (p.test_maxSize IS NULL OR length(coalesce(m.text_body,''))+length(coalesce(m.html_body,''))<p.test_maxSize)
 AND (p.test_header IS NULL OR CASE p.test_header_name WHEN 'message-id' THEN CASE WHEN p.test_header_exists=1 THEN m.provider_message_id IS NOT NULL ELSE m.provider_message_id IN(p.test_header_value,'<'||p.test_header_value||'>') END WHEN 'in-reply-to' THEN CASE WHEN p.test_header_exists=1 THEN m.in_reply_to IS NOT NULL ELSE m.in_reply_to IN(p.test_header_value,'<'||p.test_header_value||'>') END ELSE CASE WHEN p.test_header_exists=1 THEN m.references_header IS NOT NULL ELSE (' '||coalesce(m.references_header,'')||' ') LIKE p.test_header_pattern ESCAPE '!' END END)
)
 ) ELSE '['||coalesce((SELECT group_concat(coalesce(value,'null')) FROM json_each(e.stack) WHERE key<json_array_length(e.stack)-p.count),'')||CASE WHEN json_array_length(e.stack)>p.count THEN ',' ELSE '' END||
 CASE p.op
 WHEN 'OR' THEN CASE WHEN EXISTS(SELECT 1 FROM json_each(e.stack) WHERE key>=json_array_length(e.stack)-p.count AND value=1) THEN '1' WHEN EXISTS(SELECT 1 FROM json_each(e.stack) WHERE key>=json_array_length(e.stack)-p.count AND value IS NULL) THEN 'null' ELSE '0' END
 WHEN 'NOT' THEN CASE WHEN EXISTS(SELECT 1 FROM json_each(e.stack) WHERE key>=json_array_length(e.stack)-p.count AND value=0) THEN '1' WHEN EXISTS(SELECT 1 FROM json_each(e.stack) WHERE key>=json_array_length(e.stack)-p.count AND value IS NULL) THEN 'null' ELSE '0' END
 ELSE CASE WHEN EXISTS(SELECT 1 FROM json_each(e.stack) WHERE key>=json_array_length(e.stack)-p.count AND value=0) THEN '0' WHEN EXISTS(SELECT 1 FROM json_each(e.stack) WHERE key>=json_array_length(e.stack)-p.count AND value IS NULL) THEN 'null' ELSE '1' END END||']' END
 FROM eval e JOIN program p ON p.n=e.step)
 SELECT json_extract(stack,'$[0]') FROM eval ORDER BY step DESC LIMIT 1)=1
ORDER BY CASE WHEN json_extract(${sort},'$[0].asc')=1 THEN CASE json_extract(${sort},'$[0].column') WHEN 'created_at' THEN m.created_at WHEN 'subject' THEN m.subject WHEN 'from_addr' THEN m.from_addr WHEN 'to_addr' THEN m.to_addr WHEN 'size' THEN length(coalesce(m.text_body,''))+length(coalesce(m.html_body,'')) WHEN 'starred' THEN m.starred WHEN 'read' THEN m.read END END ASC,
CASE WHEN json_extract(${sort},'$[0].asc')=0 THEN CASE json_extract(${sort},'$[0].column') WHEN 'created_at' THEN m.created_at WHEN 'subject' THEN m.subject WHEN 'from_addr' THEN m.from_addr WHEN 'to_addr' THEN m.to_addr WHEN 'size' THEN length(coalesce(m.text_body,''))+length(coalesce(m.html_body,'')) WHEN 'starred' THEN m.starred WHEN 'read' THEN m.read END END DESC,
CASE WHEN json_extract(${sort},'$[1].asc')=1 THEN CASE json_extract(${sort},'$[1].column') WHEN 'created_at' THEN m.created_at WHEN 'subject' THEN m.subject WHEN 'from_addr' THEN m.from_addr WHEN 'to_addr' THEN m.to_addr WHEN 'size' THEN length(coalesce(m.text_body,''))+length(coalesce(m.html_body,'')) WHEN 'starred' THEN m.starred WHEN 'read' THEN m.read END END ASC,
CASE WHEN json_extract(${sort},'$[1].asc')=0 THEN CASE json_extract(${sort},'$[1].column') WHEN 'created_at' THEN m.created_at WHEN 'subject' THEN m.subject WHEN 'from_addr' THEN m.from_addr WHEN 'to_addr' THEN m.to_addr WHEN 'size' THEN length(coalesce(m.text_body,''))+length(coalesce(m.html_body,'')) WHEN 'starred' THEN m.starred WHEN 'read' THEN m.read END END DESC,
CASE WHEN json_extract(${sort},'$[2].asc')=1 THEN CASE json_extract(${sort},'$[2].column') WHEN 'created_at' THEN m.created_at WHEN 'subject' THEN m.subject WHEN 'from_addr' THEN m.from_addr WHEN 'to_addr' THEN m.to_addr WHEN 'size' THEN length(coalesce(m.text_body,''))+length(coalesce(m.html_body,'')) WHEN 'starred' THEN m.starred WHEN 'read' THEN m.read END END ASC,
CASE WHEN json_extract(${sort},'$[2].asc')=0 THEN CASE json_extract(${sort},'$[2].column') WHEN 'created_at' THEN m.created_at WHEN 'subject' THEN m.subject WHEN 'from_addr' THEN m.from_addr WHEN 'to_addr' THEN m.to_addr WHEN 'size' THEN length(coalesce(m.text_body,''))+length(coalesce(m.html_body,'')) WHEN 'starred' THEN m.starred WHEN 'read' THEN m.read END END DESC,
CASE WHEN json_extract(${sort},'$[3].asc')=1 THEN CASE json_extract(${sort},'$[3].column') WHEN 'created_at' THEN m.created_at WHEN 'subject' THEN m.subject WHEN 'from_addr' THEN m.from_addr WHEN 'to_addr' THEN m.to_addr WHEN 'size' THEN length(coalesce(m.text_body,''))+length(coalesce(m.html_body,'')) WHEN 'starred' THEN m.starred WHEN 'read' THEN m.read END END ASC,
CASE WHEN json_extract(${sort},'$[3].asc')=0 THEN CASE json_extract(${sort},'$[3].column') WHEN 'created_at' THEN m.created_at WHEN 'subject' THEN m.subject WHEN 'from_addr' THEN m.from_addr WHEN 'to_addr' THEN m.to_addr WHEN 'size' THEN length(coalesce(m.text_body,''))+length(coalesce(m.html_body,'')) WHEN 'starred' THEN m.starred WHEN 'read' THEN m.read END END DESC,
CASE WHEN json_extract(${sort},'$[4].asc')=1 THEN CASE json_extract(${sort},'$[4].column') WHEN 'created_at' THEN m.created_at WHEN 'subject' THEN m.subject WHEN 'from_addr' THEN m.from_addr WHEN 'to_addr' THEN m.to_addr WHEN 'size' THEN length(coalesce(m.text_body,''))+length(coalesce(m.html_body,'')) WHEN 'starred' THEN m.starred WHEN 'read' THEN m.read END END ASC,
CASE WHEN json_extract(${sort},'$[4].asc')=0 THEN CASE json_extract(${sort},'$[4].column') WHEN 'created_at' THEN m.created_at WHEN 'subject' THEN m.subject WHEN 'from_addr' THEN m.from_addr WHEN 'to_addr' THEN m.to_addr WHEN 'size' THEN length(coalesce(m.text_body,''))+length(coalesce(m.html_body,'')) WHEN 'starred' THEN m.starred WHEN 'read' THEN m.read END END DESC,
CASE WHEN json_extract(${sort},'$[5].asc')=1 THEN CASE json_extract(${sort},'$[5].column') WHEN 'created_at' THEN m.created_at WHEN 'subject' THEN m.subject WHEN 'from_addr' THEN m.from_addr WHEN 'to_addr' THEN m.to_addr WHEN 'size' THEN length(coalesce(m.text_body,''))+length(coalesce(m.html_body,'')) WHEN 'starred' THEN m.starred WHEN 'read' THEN m.read END END ASC,
CASE WHEN json_extract(${sort},'$[5].asc')=0 THEN CASE json_extract(${sort},'$[5].column') WHEN 'created_at' THEN m.created_at WHEN 'subject' THEN m.subject WHEN 'from_addr' THEN m.from_addr WHEN 'to_addr' THEN m.to_addr WHEN 'size' THEN length(coalesce(m.text_body,''))+length(coalesce(m.html_body,'')) WHEN 'starred' THEN m.starred WHEN 'read' THEN m.read END END DESC,
CASE WHEN json_extract(${sort},'$[6].asc')=1 THEN CASE json_extract(${sort},'$[6].column') WHEN 'created_at' THEN m.created_at WHEN 'subject' THEN m.subject WHEN 'from_addr' THEN m.from_addr WHEN 'to_addr' THEN m.to_addr WHEN 'size' THEN length(coalesce(m.text_body,''))+length(coalesce(m.html_body,'')) WHEN 'starred' THEN m.starred WHEN 'read' THEN m.read END END ASC,
CASE WHEN json_extract(${sort},'$[6].asc')=0 THEN CASE json_extract(${sort},'$[6].column') WHEN 'created_at' THEN m.created_at WHEN 'subject' THEN m.subject WHEN 'from_addr' THEN m.from_addr WHEN 'to_addr' THEN m.to_addr WHEN 'size' THEN length(coalesce(m.text_body,''))+length(coalesce(m.html_body,'')) WHEN 'starred' THEN m.starred WHEN 'read' THEN m.read END END DESC LIMIT 10000`,
	);
	let ordered = rows.map((row) => row.id);
	if (args.collapseThreads) {
		const seen = new Set<string>();
		ordered = rows
			.filter((row) => {
				if (seen.has(row.thread)) return false;
				seen.add(row.thread);
				return true;
			})
			.map((row) => row.id);
	}
	let position = Number(args.position ?? 0),
		limit = Math.min(Math.max(Number(args.limit ?? 250), 0), 250);
	if (!Number.isFinite(position) || !Number.isFinite(limit))
		throw invalidArguments("Invalid query position or limit");
	if (args.anchor) {
		const index = ordered.indexOf(String(args.anchor));
		if (index < 0) return { type: "anchorNotFound" };
		position = index + Number(args.anchorOffset ?? 0);
		if (!Number.isFinite(position))
			throw invalidArguments("Invalid anchor offset");
	}
	if (position < 0) position = Math.max(ordered.length + position, 0);
	return {
		position,
		ids: ordered.slice(position, position + limit),
		...(args.calculateTotal ? { total: ordered.length } : {}),
	};
}
