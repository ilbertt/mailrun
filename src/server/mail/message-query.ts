import { z } from "zod";
import { withDatabase, seconds } from "../db";
import { readMailboxScope } from "./read-scope";
import { tracksAccountIdentity } from "../../lib/profile/identity-utils";
import type { User } from "../../shared/contracts";
import type { Message } from "../../hooks/types";
import {
	parseSearchQuery,
	buildFtsMatch,
	tokenizeSearchText,
} from "../../lib/search/query-utils";
import {
	normalizeEmailAddress,
	getFirstEmailAddressEntry,
} from "../../lib/email/address";

const optionalFilter = z
	.string()
	.optional()
	.transform((value) => value || undefined);
export const messageQuerySchema = z.object({
	mailboxId: optionalFilter,
	folderId: optionalFilter,
	direction: z
		.string()
		.optional()
		.transform((value) =>
			value === "inbound" || value === "outbound" ? value : undefined,
		),
	status: optionalFilter,
	q: z.string().trim().default(""),
	title: z.string().trim().default(""),
	read: z.string().optional(),
	starred: z.string().optional(),
	snoozed: z.string().optional(),
	scheduled: z.string().optional(),
	group: z.string().optional(),
	limit: z.coerce
		.number()
		.int()
		.transform((value) => Math.min(value, 100))
		.default(50),
	offset: z.coerce
		.number()
		.int()
		.transform((value) => Math.max(value, 0))
		.default(0),
	timeZone: z.string().default("UTC"),
});
export type MessageQueryInput = z.input<typeof messageQuerySchema>;
const rawMessageSchema = z.object({
	id: z.string(),
	user_id: z.string(),
	mailbox_id: z.string().nullable(),
	folder_id: z.string().nullable(),
	direction: z.enum(["inbound", "outbound"]),
	provider_message_id: z.string().nullable(),
	from_addr: z.string(),
	to_addr: z.string(),
	cc_addr: z.string().nullable(),
	bcc_addr: z.string().nullable(),
	reply_to: z.string().nullable(),
	subject: z.string().nullable(),
	snippet: z.string().nullable(),
	status: z.string(),
	read: z.number(),
	starred: z.number(),
	snoozed_until: z.number().nullable(),
	thread_id: z.string().nullable(),
	in_reply_to: z.string().nullable(),
	references_header: z.string().nullable(),
	created_at: z.number(),
	trashed_at: z.number().nullable().optional(),
	spam_score: z.number().nullable(),
	spam_verdict: z.enum(["inbox", "suspicious", "spam"]).nullable(),
	spam_signals: z.string().nullable(),
	spam_analyzed_at: z.number().nullable(),
	spam_analysis_error: z.string().nullable(),
});
export const iso = (value: number | null | undefined) =>
	value == null ? null : new Date(value * 1000).toISOString();
export function toMessage(value: unknown): Message {
	const row = rawMessageSchema.parse(value);
	return {
		id: row.id,
		userId: row.user_id,
		mailboxId: row.mailbox_id,
		folderId: row.folder_id,
		direction: row.direction,
		providerMessageId: row.provider_message_id,
		fromAddr: row.from_addr,
		toAddr: row.to_addr,
		ccAddr: row.cc_addr,
		bccAddr: row.bcc_addr,
		replyTo: row.reply_to,
		subject: row.subject,
		snippet: row.snippet,
		status: row.status,
		read: !!row.read,
		starred: !!row.starred,
		snoozedUntil: iso(row.snoozed_until),
		threadId: row.thread_id,
		inReplyTo: row.in_reply_to,
		references: row.references_header,
		createdAt: new Date(row.created_at * 1000).toISOString(),
		...(row.trashed_at !== undefined ? { trashedAt: iso(row.trashed_at) } : {}),
		spamScore: row.spam_score,
		spamVerdict: row.spam_verdict,
		spamSignals: row.spam_signals,
		spamAnalyzedAt: iso(row.spam_analyzed_at),
		spamAnalysisError: row.spam_analysis_error,
	};
}
// Only the original source columns belong on the legacy detail wire contract.
// Native delivery revisions and other runtime-only columns stay internal.
const storedBodySchema = z.object({
	text_body: z.string().nullable(),
	html_body: z.string().nullable(),
	raw_r2_key: z.string().nullable(),
});
export function toStoredSourceMessage(value: unknown) {
	const row = storedBodySchema.parse(value);
	return {
		...toMessage(value),
		textBody: row.text_body,
		htmlBody: row.html_body,
		rawR2Key: row.raw_r2_key,
	};
}
export async function queryMessages(
	user: User,
	input: MessageQueryInput,
	authorization?: {
		mailboxIds: string[] | null;
		includeTemplates?: boolean;
		authorDraftsOnly?: boolean;
	},
) {
	const data = messageQuerySchema.parse(input);
	const {
		mailboxes,
		ids: scope,
		fallback,
	} = await readMailboxScope(user, data.mailboxId, authorization?.mailboxIds);
	const parsed = parseSearchQuery(
		data.title ? `${data.q} subject:"${data.title}"` : data.q,
		data.timeZone,
	);
	const tokens = tokenizeSearchText(parsed.text);
	const render = (token: (typeof tokens)[number]) =>
		token.phrase ? `"${token.term}"` : token.term;
	const match = buildFtsMatch({
		...parsed,
		text: tokens
			.filter((token) => !token.negate)
			.map(render)
			.join(" "),
	});
	const excluded =
		tokens
			.filter((token) => token.negate)
			.map((token) =>
				buildFtsMatch({ text: render(token), needsFullText: true }),
			)
			.filter(Boolean)
			.join(" OR ") || null;
	const grouped = data.group === "thread" && data.status !== "draft" ? 1 : 0;
	const read = data.read === "read" ? 1 : data.read === "unread" ? 0 : null,
		searchRead =
			parsed.read === "read" ? 1 : parsed.read === "unread" ? 0 : null;
	const rows = await withDatabase(
		(sql) => sql.SourceMessagePage`
 WITH filtered AS (
  SELECT m.id,m.mailbox_id,m.thread_id,m.created_at,m.read,
   CASE WHEN ${grouped}=1 THEN coalesce(m.thread_id,m.id) ELSE m.id END AS group_key
  FROM messages m
  WHERE (m.mailbox_id IN (SELECT value FROM json_each(${scope})) OR (${fallback}=1 AND m.user_id=${user.id}))
  AND (${authorization?.authorDraftsOnly ? 1 : 0}=0 OR m.status!='draft' OR m.user_id=${user.id})
  AND (${data.direction ?? null} IS NULL OR m.direction=${data.direction ?? null})
  AND (${data.folderId ?? null} IS NULL OR m.folder_id=${data.folderId ?? null})
  AND (${data.status ?? null} IS NULL OR m.status=${data.status ?? null})
  AND (${data.status === "template" || authorization?.includeTemplates ? 1 : 0}=1 OR m.status!='template')
  AND (${data.status === "received" && !data.folderId ? 1 : 0}=0 OR (m.folder_id IS NULL AND (m.snoozed_until IS NULL OR m.snoozed_until<=${seconds()})))
  AND (${data.starred === "true" || parsed.starred ? 1 : 0}=0 OR m.starred=1)
  AND (${data.snoozed === "true" ? 1 : 0}=0 OR (m.status='received' AND m.folder_id IS NULL AND m.snoozed_until>${seconds()}))
  AND (${data.scheduled === "true" ? 1 : 0}=0 OR (m.direction='outbound' AND m.status='queued' AND EXISTS(SELECT 1 FROM outbound_jobs j WHERE j.message_id=m.id AND j.status='queued' AND j.scheduled_at IS NOT NULL)))
  AND (${read} IS NULL OR m.read=${read}) AND (${searchRead} IS NULL OR m.read=${searchRead})
  AND (${parsed.hasAttachment ? 1 : 0}=0 OR EXISTS(SELECT 1 FROM message_attachments a WHERE a.message_id=m.id AND a.disposition='attachment'))
  AND (${parsed.after ? Math.floor(parsed.after.getTime() / 1000) : null} IS NULL OR m.created_at>=${parsed.after ? Math.floor(parsed.after.getTime() / 1000) : null})
  AND (${parsed.before ? Math.floor(parsed.before.getTime() / 1000) : null} IS NULL OR m.created_at<${parsed.before ? Math.floor(parsed.before.getTime() / 1000) : null})
  AND (${match} IS NULL OR m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${match ?? '""'}))
  AND (${excluded} IS NULL OR m.rowid NOT IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${excluded ?? '""'}))
 ), ranked AS (
  SELECT filtered.*,row_number() OVER(PARTITION BY group_key ORDER BY created_at DESC,id DESC) AS position FROM filtered
 ), heads AS (SELECT * FROM ranked WHERE position=1), page AS (
  SELECT * FROM heads ORDER BY created_at DESC,id DESC LIMIT ${data.limit} OFFSET ${data.offset}
 ), totals AS (SELECT count(*) AS total FROM heads), conversations AS (
  SELECT t.thread_id,count(*) AS conversation_count,sum(CASE WHEN t.read=0 THEN 1 ELSE 0 END) AS conversation_unread
  FROM messages t WHERE (t.mailbox_id IN(SELECT value FROM json_each(${scope})) OR (${fallback}=1 AND t.user_id=${user.id}))
  AND t.thread_id IN(SELECT thread_id FROM page WHERE thread_id IS NOT NULL AND thread_id!='') AND t.status NOT IN('draft','trash') GROUP BY t.thread_id
 ), grouped_rows AS (
  SELECT f.group_key,count(*) AS thread_count,sum(CASE WHEN f.read=0 THEN 1 ELSE 0 END) AS thread_unread,CAST(json_group_array(f.id) AS TEXT) AS member_ids FROM filtered f WHERE f.group_key IN(SELECT group_key FROM page) GROUP BY f.group_key
 )
 SELECT m.id,m.user_id,m.mailbox_id,m.folder_id,m.direction,m.provider_message_id,m.from_addr,m.to_addr,m.cc_addr,m.bcc_addr,m.reply_to,m.subject,m.snippet,m.status,m.read,m.starred,m.snoozed_until,m.thread_id,m.in_reply_to,m.references_header,m.created_at,
   m.trashed_at,m.spam_score,m.spam_verdict,m.spam_signals,m.spam_analyzed_at,m.spam_analysis_error,totals.total,grouped_rows.thread_count,grouped_rows.thread_unread,grouped_rows.member_ids,
 CASE WHEN ${data.scheduled === "true" ? 1 : 0}=1 THEN (SELECT j.scheduled_at FROM outbound_jobs j WHERE j.message_id=page.id AND j.status='queued' AND j.scheduled_at IS NOT NULL ORDER BY j.rowid DESC LIMIT 1) ELSE NULL END AS scheduled_at,
 conversations.conversation_count,conversations.conversation_unread
 FROM totals LEFT JOIN page ON 1=1 LEFT JOIN messages m ON m.id=page.id LEFT JOIN grouped_rows ON grouped_rows.group_key=page.group_key LEFT JOIN conversations ON conversations.thread_id=page.thread_id ORDER BY page.created_at DESC,page.id DESC`,
	);
	const messages = rows
		.filter((row) => row.id != null)
		.map((row) => {
			const message = toMessage(row);
			return {
				...message,
				threadCount: message.threadId ? Number(row.conversation_count) || 1 : 1,
				threadUnread: Number(
					(grouped
						? row.thread_unread
						: message.threadId
							? row.conversation_unread
							: 0) ?? 0,
				),
				...(grouped
					? {
							threadMessageIds: z
								.array(z.string())
								.parse(JSON.parse(String(row.member_ids))),
						}
					: {}),
				...(data.scheduled === "true" && row.scheduled_at != null
					? { scheduledAt: iso(z.number().parse(row.scheduled_at)) }
					: {}),
			};
		});
	if (messages.length) {
		const parties = JSON.stringify(
			messages.map((message) => ({
				userId: message.userId,
				from: normalizeEmailAddress(message.fromAddr),
				to: normalizeEmailAddress(getFirstEmailAddressEntry(message.toAddr)),
			})),
		);
		const contacts = await withDatabase(
			(sql) => sql.MessagePartyContacts`
   SELECT DISTINCT c.user_id,c.email,c.display_name FROM json_each(${parties}) p JOIN contacts c
   ON c.user_id=json_extract(p.value,'$.userId') AND c.email IN(json_extract(p.value,'$.from'),json_extract(p.value,'$.to'))
   WHERE c.display_name IS NOT NULL AND c.display_name!='' `,
		);
		const byOwner = new Map<string, Map<string, string>>();
		for (const contact of contacts) {
			let map = byOwner.get(contact.user_id);
			if (!map) byOwner.set(contact.user_id, (map = new Map()));
			if (contact.display_name) map.set(contact.email, contact.display_name);
		}
		const mailboxNames = new Map(
			mailboxes.map((box) => [
				box.id,
				box.user_id === user.id &&
				tracksAccountIdentity(
					{ localPart: box.local_part, hostname: box.hostname, type: box.type },
					user.email,
				)
					? user.name
					: (box.display_name ?? box.local_part),
			]),
		);
		for (const message of messages) {
			const contactMap = byOwner.get(message.userId);
			Object.assign(message, {
				fromContactName:
					(message.direction === "outbound" && message.mailboxId
						? mailboxNames.get(message.mailboxId)
						: null) ??
					contactMap?.get(normalizeEmailAddress(message.fromAddr)) ??
					null,
				toContactName:
					contactMap?.get(
						normalizeEmailAddress(getFirstEmailAddressEntry(message.toAddr)),
					) ?? null,
			});
		}
	}
	return {
		messages,
		total: Number(rows[0]?.total ?? 0),
		limit: data.limit,
		offset: data.offset,
		grouped: !!grouped,
	};
}
