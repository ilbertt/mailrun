import { assertApiPrincipal } from "../auth/key-principal";
import { withDatabase, seconds } from "../db";
import { parseSearchQuery, buildFtsMatch } from "../../lib/search/query-utils";
import { htmlToReadableText } from "../../lib/email/reply-content-utils";
import { emailToolSchemas } from "./tool-contracts";
import { ownToolMessage, publicToolMessage } from "./messages";
import { requireToolAccess, withToolMutation } from "./access";
import { createAgentDraft, editAgentDraft, discardAgentDraft } from "./drafts";
import { getReplyRecipients } from "./reply";
import { requestAgentSend } from "./approvals";
import { applyAgentMoves } from "./organize";
import type {
	AgentToolContext,
	EmailToolName,
	AgentDraftEditInput,
} from "./types";
export {
	EMAIL_TOOL_NAMES,
	emailToolDescriptions,
	emailToolSchemas,
} from "./tool-contracts";
export async function runEmailTool(
	ctx: AgentToolContext,
	name: EmailToolName,
	rawInput: unknown,
): Promise<unknown> {
	const input = emailToolSchemas[name].parse(rawInput) as Record<
		string,
		unknown
	>;
	if (name === "list_emails" || name === "search_emails") {
		await requireToolAccess(ctx);
		const folder = typeof input.folder === "string" ? input.folder : null,
			parsed = parseSearchQuery(
				typeof input.query === "string" ? input.query : "",
				ctx.timeZone ?? "UTC",
			),
			match = buildFtsMatch(parsed),
			limit = input.limit as number;
		const [cursor] =
			typeof input.cursor === "string"
				? await withDatabase(
						(sql) =>
							sql.NativeAgentPageCursor`SELECT created_at FROM messages WHERE id=${input.cursor as string} AND mailbox_id=${ctx.mailboxId} AND (status!='draft' OR user_id=${ctx.user.id})`,
					)
				: [];
		if (typeof input.cursor === "string" && !cursor)
			throw new Error("Message not found");
		// Metadata pages and cursors must not materialize large email bodies.
		const rows = await withDatabase(
			(sql) => sql.NativeAgentMessagePage`/* @notNull id */
/* @notNull from_addr */
/* @notNull to_addr */
/* @notNull created_at */
/* @notNull status */
SELECT m.id,m.mailbox_id,m.from_addr,m.to_addr,m.cc_addr,m.subject,m.snippet,m.direction,m.status,m.read,m.starred,m.thread_id,m.created_at FROM messages m WHERE m.mailbox_id=${ctx.mailboxId} AND (m.status!='draft' OR m.user_id=${ctx.user.id})
AND (CASE ${folder} WHEN 'draft' THEN m.status='draft' AND m.user_id=${ctx.user.id} WHEN 'sent' THEN m.status='sent' WHEN 'scheduled' THEN m.status='queued' AND m.direction='outbound' AND EXISTS(SELECT 1 FROM outbound_jobs j WHERE j.message_id=m.id AND j.status='queued' AND j.scheduled_at IS NOT NULL) WHEN 'inbox' THEN m.status='received' AND m.folder_id IS NULL WHEN 'archived' THEN m.status='archived' WHEN 'trash' THEN m.status='trash' WHEN 'spam' THEN m.status='spam' ELSE m.user_id=${ctx.user.id} OR m.direction='inbound' END)
AND (${cursor?.created_at ?? null} IS NULL OR m.created_at<${cursor?.created_at ?? null})
AND (${match} IS NULL OR m.rowid IN(SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${match ?? '""'}))
AND (${parsed.read === "read" ? 1 : parsed.read === "unread" ? 0 : null} IS NULL OR m.read=${parsed.read === "read" ? 1 : parsed.read === "unread" ? 0 : null})
AND (${parsed.starred ? 1 : 0}=0 OR m.starred=1)
AND (${parsed.hasAttachment ? 1 : 0}=0 OR EXISTS(SELECT 1 FROM message_attachments a WHERE a.message_id=m.id AND a.disposition='attachment' AND a.trashed_at IS NULL))
AND (${parsed.after ? Math.floor(parsed.after.getTime() / 1000) : null} IS NULL OR m.created_at>=${parsed.after ? Math.floor(parsed.after.getTime() / 1000) : null})
AND (${parsed.before ? Math.floor(parsed.before.getTime() / 1000) : null} IS NULL OR m.created_at<${parsed.before ? Math.floor(parsed.before.getTime() / 1000) : null}) ORDER BY m.created_at DESC,m.rowid LIMIT ${limit + 1}`,
		);
		return {
			emails: rows.slice(0, limit).map(publicToolMessage),
			nextCursor: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null,
		};
	}
	if (name === "get_email") {
		await requireToolAccess(ctx);
		// Body, attachment list and edit revision must describe the same version.
		// Otherwise a concurrent writer can pair an old body with a new revision.
		const { row, attachments, metadata } = await withDatabase((sql) =>
			sql.begin(async (sql) => {
				await assertApiPrincipal(sql, ctx.actor ?? ctx.user, ctx.mailboxId);
				const [row] =
					await sql.NativeAgentEmailSnapshot`SELECT * FROM messages WHERE id=${input.emailId as string} AND mailbox_id=${ctx.mailboxId} AND (status!='draft' OR user_id=${ctx.user.id})`;
				if (!row) throw new Error("Message not found");
				const attachments =
					await sql.NativeAgentReadAttachments`SELECT id,filename,size,content_type FROM message_attachments WHERE message_id=${row.id} AND trashed_at IS NULL ORDER BY created_at,rowid`;
				const metadata =
					row.status === "draft"
						? await sql.NativeAgentReadDraftRevision`SELECT revision,scheduled_at FROM agent_draft_metadata WHERE draft_id=${row.id}`
						: [];
				return { row, attachments, metadata };
			}),
		);
		return {
			...publicToolMessage(row),
			...(row.status === "draft"
				? {
						bcc: row.bcc_addr,
						revision: metadata[0]?.revision ?? null,
						scheduledAt:
							metadata[0]?.scheduled_at == null
								? null
								: new Date(metadata[0].scheduled_at * 1000).toISOString(),
					}
				: {}),
			text: (row.text_body || htmlToReadableText(row.html_body)).slice(
				0,
				30000,
			),
			truncated: (row.text_body || row.html_body || "").length > 30000,
			attachments: attachments.map((file) => ({
				id: file.id,
				filename: file.filename,
				size: file.size,
				contentType: file.content_type,
			})),
		};
	}
	if (name === "get_thread") {
		const anchor = await ownToolMessage(ctx, input.emailId as string);
		const rows = anchor.thread_id
			? await withDatabase(
					(sql) =>
						sql.NativeAgentReadThread`SELECT * FROM messages WHERE mailbox_id=${ctx.mailboxId} AND thread_id=${anchor.thread_id} AND (status!='draft' OR user_id=${ctx.user.id}) ORDER BY created_at DESC,rowid LIMIT 21`,
				)
			: [anchor];
		return {
			emails: rows
				.slice(0, 20)
				.reverse()
				.map((row) => ({
					...publicToolMessage(row),
					text: (row.text_body || htmlToReadableText(row.html_body)).slice(
						0,
						5000,
					),
				})),
			truncated: rows.length > 20,
		};
	}
	if (name === "draft_email")
		return createAgentDraft(ctx, {
			to: input.to as string,
			subject: input.subject as string,
			body: input.body as string,
		});
	if (name === "draft_reply") {
		const source = await ownToolMessage(ctx, input.emailId as string);
		if (
			source.direction !== "inbound" ||
			source.status === "spam" ||
			source.status === "trash"
		)
			throw new Error("Cannot reply to this message");
		const recipients = await getReplyRecipients(
				ctx,
				source,
				input.replyAll as boolean,
			),
			subject = /^re\s*(\[\d+\])?\s*:/i.test(source.subject ?? "")
				? source.subject!
				: `Re: ${source.subject ?? ""}`;
		return createAgentDraft(ctx, {
			...recipients,
			subject,
			body: input.body as string,
			source,
		});
	}
	if (name === "edit_draft")
		return editAgentDraft(ctx, input as AgentDraftEditInput);
	if (name === "review_draft_send") {
		if (ctx.origin !== "chat")
			throw new Error("Open the draft in Mailflare to review delivery");
		const result = await requestAgentSend(
			ctx,
			input.draftId as string,
			input.expectedRevision as number,
		);
		return {
			draftId: input.draftId,
			revision: input.expectedRevision,
			status: "pending_approval",
			scheduledAt: result.snapshot.scheduledAt,
			reviewUrl: result.reviewUrl,
		};
	}
	if (name === "mark_email_read") {
		const row = await ownToolMessage(ctx, input.emailId as string);
		if (ctx.origin === "chat")
			return {
				action: name,
				status: "pending_approval",
				emailId: row.id,
				read: input.read,
				emails: [publicToolMessage(row)],
			};
		await withToolMutation(ctx, "read", async (sql) => {
			const [updated] =
				await sql.NativeAgentMarkRead`UPDATE messages SET read=${input.read ? 1 : 0} WHERE id=${row.id} AND mailbox_id=${ctx.mailboxId} AND (status!='draft' OR user_id=${ctx.user.id}) RETURNING id`;
			if (!updated) throw new Error("Message not found");
		});
		return { emailId: row.id, read: input.read };
	}
	if (name === "move_email" || name === "move_emails") {
		await requireToolAccess(ctx, "manage");
		const ids =
				name === "move_email"
					? [input.emailId as string]
					: [...new Set(input.emailIds as string[])],
			rows = await Promise.all(ids.map((value) => ownToolMessage(ctx, value))),
			destination = input.destination as string;
		if (rows.some((row) => row.status === "draft" || row.status === "sent"))
			throw new Error("Cannot move this message");
		if (ctx.origin === "chat")
			return {
				action: name,
				status: "pending_approval",
				emailIds: ids,
				destination,
				emails: rows.map(publicToolMessage),
			};
		await withToolMutation(ctx, "manage", (sql) =>
			applyAgentMoves(sql, ctx, ids, destination),
		);
		return { emailIds: ids, destination, status: "approved" };
	}
	if (name === "discard_draft") {
		if (ctx.origin === "chat") {
			const row = await ownToolMessage(ctx, input.draftId as string);
			const [meta] = await withDatabase(
				(sql) =>
					sql.NativeAgentDiscardProposal`SELECT revision,human_edited_at FROM agent_draft_metadata WHERE draft_id=${row.id}`,
			);
			if (
				row.status !== "draft" ||
				!meta ||
				meta.revision !== input.expectedRevision ||
				meta.human_edited_at
			)
				throw new Error("Draft changed or cannot be discarded");
			return {
				action: name,
				status: "pending_approval",
				draftId: row.id,
				expectedRevision: input.expectedRevision,
				emails: [publicToolMessage(row)],
			};
		}
		return discardAgentDraft(
			ctx,
			input.draftId as string,
			input.expectedRevision as number,
		);
	}
	throw new Error("Unknown tool");
}
