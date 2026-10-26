import { z } from "zod";
import { withDatabase, seconds } from "../db";
import { listMailboxes } from "./repository";
import type { User } from "../../shared/contracts";
import type { Message } from "../../hooks/types";
import {
	parseSearchQuery,
	buildFtsMatch,
	tokenizeSearchText,
} from "../../lib/search/query-utils";
import { getEmailAddress } from "../../lib/email/address";

export const messageQuerySchema = z.object({
	mailboxId: z.string().min(1).max(200).optional(),
	folderId: z.string().min(1).max(200).optional(),
	direction: z.enum(["inbound", "outbound"]).optional(),
	status: z
		.enum([
			"received",
			"sent",
			"draft",
			"queued",
			"failed",
			"archived",
			"trash",
			"spam",
			"template",
		])
		.optional(),
	q: z.string().max(500).default(""),
	title: z.string().max(500).default(""),
	read: z.enum(["read", "unread", "all"]).optional(),
	starred: z.enum(["true", "false"]).optional(),
	snoozed: z.enum(["true", "false"]).optional(),
	scheduled: z.enum(["true", "false"]).optional(),
	group: z.literal("thread").optional(),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.transform((value) => Math.min(value, 100))
		.default(50),
	offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
	timeZone: z.string().max(100).default("UTC"),
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
		spamScore: row.spam_score,
		spamVerdict: row.spam_verdict,
		spamSignals: row.spam_signals,
		spamAnalyzedAt: iso(row.spam_analyzed_at),
		spamAnalysisError: row.spam_analysis_error,
	};
}
export async function queryMessages(
	user: User,
	input: MessageQueryInput,
	navigation = false,
) {
	const data = messageQuerySchema.parse(input);
	const mailboxes = await listMailboxes(user);
	if (
		data.mailboxId &&
		!mailboxes.some((mailbox) => mailbox.id === data.mailboxId)
	)
		throw new Response("Mailbox not found", { status: 404 });
	const scope = JSON.stringify(
		data.mailboxId ? [data.mailboxId] : mailboxes.map((mailbox) => mailbox.id),
	);
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
   CASE WHEN ${grouped}=1 AND m.status!='draft' THEN json_array(m.mailbox_id,coalesce(m.thread_id,m.id)) ELSE json_array(m.mailbox_id,m.id) END AS group_key
  FROM messages m
  WHERE (m.mailbox_id IN (SELECT value FROM json_each(${scope})) OR (${mailboxes.length === 0 && !data.mailboxId ? 1 : 0}=1 AND m.user_id=${user.id}))
  AND (m.status!='draft' OR m.user_id=${user.id})
  AND (${data.direction ?? null} IS NULL OR m.direction=${data.direction ?? null})
  AND (${data.folderId ?? null} IS NULL OR m.folder_id=${data.folderId ?? null})
  AND (${data.status ?? null} IS NULL OR m.status=${data.status ?? null})
  AND (${data.status === "template" ? 1 : 0}=1 OR m.status!='template')
  AND (${data.status === "received" && !data.folderId ? 1 : 0}=0 OR (m.folder_id IS NULL AND (m.snoozed_until IS NULL OR m.snoozed_until<=${seconds()})))
  AND (${data.starred === "true" || parsed.starred ? 1 : 0}=0 OR m.starred=1)
  AND (${data.snoozed === "true" ? 1 : 0}=0 OR (m.status='received' AND m.folder_id IS NULL AND m.snoozed_until>${seconds()}))
  AND (${data.scheduled === "true" ? 1 : 0}=0 OR (m.direction='outbound' AND m.status='queued' AND EXISTS(SELECT 1 FROM outbound_jobs j WHERE j.message_id=m.id AND j.status='queued' AND j.scheduled_at IS NOT NULL)))
  AND (${read} IS NULL OR m.read=${read}) AND (${searchRead} IS NULL OR m.read=${searchRead})
  AND (${parsed.hasAttachment ? 1 : 0}=0 OR EXISTS(SELECT 1 FROM message_attachments a WHERE a.message_id=m.id AND a.disposition='attachment' AND a.trashed_at IS NULL))
  AND (${parsed.after ? Math.floor(parsed.after.getTime() / 1000) : null} IS NULL OR m.created_at>=${parsed.after ? Math.floor(parsed.after.getTime() / 1000) : null})
  AND (${parsed.before ? Math.floor(parsed.before.getTime() / 1000) : null} IS NULL OR m.created_at<${parsed.before ? Math.floor(parsed.before.getTime() / 1000) : null})
  AND (${match} IS NULL OR m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${match ?? '""'}))
  AND (${excluded} IS NULL OR m.rowid NOT IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${excluded ?? '""'}))
 ), ranked AS (
  SELECT filtered.*,row_number() OVER(PARTITION BY group_key ORDER BY created_at DESC,id DESC) AS position FROM filtered
 ), heads AS (SELECT * FROM ranked WHERE position=1), page AS (
  SELECT * FROM heads ORDER BY created_at DESC,id DESC LIMIT ${navigation ? -1 : data.limit} OFFSET ${navigation ? 0 : data.offset}
 ), totals AS (SELECT count(*) AS total FROM heads), grouped_rows AS (
  SELECT f.group_key,count(*) AS thread_count,sum(CASE WHEN f.read=0 THEN 1 ELSE 0 END) AS thread_unread,CAST(json_group_array(f.id) AS TEXT) AS member_ids FROM filtered f WHERE f.group_key IN(SELECT group_key FROM page) GROUP BY f.group_key
 )
 SELECT m.id,m.user_id,m.mailbox_id,m.folder_id,m.direction,m.provider_message_id,m.from_addr,m.to_addr,m.cc_addr,m.bcc_addr,m.reply_to,m.subject,m.snippet,m.status,m.read,m.starred,m.snoozed_until,m.thread_id,m.in_reply_to,m.references_header,m.created_at,
   m.spam_score,m.spam_verdict,m.spam_signals,m.spam_analyzed_at,m.spam_analysis_error,totals.total,grouped_rows.thread_count,grouped_rows.thread_unread,grouped_rows.member_ids,
 (SELECT min(j.scheduled_at) FROM outbound_jobs j WHERE j.message_id=page.id AND j.status='queued' AND j.scheduled_at IS NOT NULL) AS scheduled_at,
 (SELECT count(*) FROM messages t WHERE t.mailbox_id=page.mailbox_id AND t.thread_id=page.thread_id AND t.status NOT IN ('draft','trash')) AS conversation_count,
 (SELECT sum(CASE WHEN t.read=0 THEN 1 ELSE 0 END) FROM messages t WHERE t.mailbox_id=page.mailbox_id AND t.thread_id=page.thread_id AND t.status NOT IN ('draft','trash')) AS conversation_unread
 FROM totals LEFT JOIN page ON 1=1 LEFT JOIN messages m ON m.id=page.id LEFT JOIN grouped_rows ON grouped_rows.group_key=page.group_key ORDER BY page.created_at DESC,page.id DESC`,
	);
	const messages = rows
		.filter((row) => row.id != null)
		.map((row) => {
			const message = toMessage(row);
			return {
				...message,
				...(grouped
					? {
							threadCount: Number(row.thread_count),
							threadUnread: Number(row.thread_unread),
							threadMessageIds: z
								.array(z.string())
								.parse(JSON.parse(String(row.member_ids))),
						}
					: message.threadId
						? {
								threadCount: Number(row.conversation_count),
								threadUnread: Number(row.conversation_unread ?? 0),
							}
						: {}),
				scheduledAt: iso(z.number().nullable().parse(row.scheduled_at)),
			};
		});
	if (!navigation && messages.length) {
		const addresses = JSON.stringify([
			...new Set(
				messages.flatMap((message) => [
					getEmailAddress(message.fromAddr),
					getEmailAddress(message.toAddr),
				]),
			),
		]);
		const contacts = await withDatabase(
			(sql) =>
				sql.MessagePartyContacts`SELECT email,display_name,avatar_key FROM contacts WHERE user_id=${user.id} AND lower(email) IN (SELECT lower(value) FROM json_each(${addresses}))`,
		);
		const byEmail = new Map(
			contacts.map((contact) => [contact.email.toLowerCase(), contact]),
		);
		for (const message of messages) {
			const from = byEmail.get(getEmailAddress(message.fromAddr).toLowerCase()),
				to = byEmail.get(getEmailAddress(message.toAddr).toLowerCase());
			Object.assign(message, {
				fromContactName: from?.display_name,
				fromContactHasAvatar: !!from?.avatar_key,
				toContactName: to?.display_name,
			});
		}
	}
	return {
		messages,
		total: Number(rows[0]?.total ?? 0),
		limit: data.limit,
		offset: data.offset,
	};
}
