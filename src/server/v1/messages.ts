import type { ApiKeyAuthorization } from "../auth/api-key";
import { queryMessages, iso } from "../mail/message-query";
import { currentProfile } from "../api/settings";
import { getRequestTimeZone } from "../../lib/time/utils";
import { withDatabase } from "../db";
export async function v1Messages(request: Request, key: ApiKeyAuthorization) {
	const url = new URL(request.url),
		direction = url.searchParams.get("direction"),
		profile = await currentProfile(key.user);
	const empty = Number(url.searchParams.get("limit") ?? 50) === 0;
	const result = await queryMessages(
		key.user,
		{
			mailboxId: url.searchParams.get("mailboxId") || undefined,
			direction:
				direction === "inbound" || direction === "outbound"
					? direction
					: undefined,
			q: url.searchParams.get("q")?.trim() ?? "",
			limit: empty ? 1 : Number(url.searchParams.get("limit") ?? 50),
			timeZone: getRequestTimeZone(request, profile.time_zone),
		},
		{
			mailboxIds: key.mailboxIds,
			includeTemplates: true,
			authorDraftsOnly: true,
		},
	);
	if (empty) return [];
	const ids = result.messages.map((row) => row.id);
	const rows = ids.length
		? await withDatabase(
				(sql) =>
					sql.NativeV1MessageBodies`SELECT * FROM messages WHERE id IN(SELECT value FROM json_each(${JSON.stringify(ids)}))`,
			)
		: [];
	const indexed = new Map(rows.map((row) => [row.id, row]));
	return ids.flatMap((id) => {
		const m = indexed.get(id);
		if (!m) return [];
		return [
			{
				id: m.id,
				userId: m.user_id,
				mailboxId: m.mailbox_id,
				direction: m.direction,
				providerMessageId: m.provider_message_id,
				folderId: m.folder_id,
				fromAddr: m.from_addr,
				toAddr: m.to_addr,
				ccAddr: m.cc_addr,
				bccAddr: m.bcc_addr,
				replyTo: m.reply_to,
				subject: m.subject,
				snippet: m.snippet,
				textBody: m.text_body,
				htmlBody: m.html_body,
				rawR2Key: m.raw_r2_key,
				status: m.status,
				read: !!m.read,
				starred: !!m.starred,
				snoozedUntil: iso(m.snoozed_until),
				threadId: m.thread_id,
				inReplyTo: m.in_reply_to,
				references: m.references_header,
				spamScore: m.spam_score,
				spamVerdict: m.spam_verdict,
				spamSignals: m.spam_signals,
				spamAnalyzedAt: iso(m.spam_analyzed_at),
				spamAnalysisError: m.spam_analysis_error,
				trashedAt: iso(m.trashed_at),
				createdAt: iso(m.created_at),
			},
		];
	});
}
