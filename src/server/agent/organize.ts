import { seconds, type AppSQL } from "../db";
import { spamFeedback } from "../mail/spam-feedback";
import { audit } from "../mail/message-actions";
import type { AgentToolContext } from "./types";
export async function applyAgentMoves(
	sql: AppSQL,
	ctx: AgentToolContext,
	ids: string[],
	destination: string,
) {
	for (const messageId of ids) {
		const [current] =
			await sql.NativeAgentMoveCurrent`SELECT status FROM messages WHERE id=${messageId} AND mailbox_id=${ctx.mailboxId} AND status NOT IN('draft','sent')`;
		if (!current) throw new Error("Cannot move this message");
		const [sending] =
			await sql.NativeAgentMoveSending`SELECT id FROM outbound_jobs WHERE status IN('queued','sending') AND ((message_id=${messageId} AND (status='sending' OR json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.submittedDraftId') IS NOT NULL)) OR json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.submittedDraftId')=${messageId}) LIMIT 1`;
		if (sending) throw new Error("A message is being sent");
		if (
			destination === "spam" ||
			(destination === "inbox" && current.status === "spam")
		) {
			if (
				!(await spamFeedback(
					sql,
					ctx.user,
					messageId,
					destination === "spam" ? "spam" : "ham",
				))
			)
				throw new Error("Message could not be moved");
		} else {
			const status = destination === "inbox" ? "received" : destination;
			await sql.NativeAgentMoveMessage`UPDATE messages SET status=${status},trashed_at=CASE WHEN ${status}='trash' THEN ${seconds()} ELSE NULL END WHERE id=${messageId} AND mailbox_id=${ctx.mailboxId}`;
			await audit(sql, ctx.user, ctx.mailboxId, messageId, "email.delete", {
				status,
			});
		}
		if (destination === "trash")
			await sql.NativeAgentMoveCancelQueued`UPDATE outbound_jobs SET status='cancelled',updated_at=${seconds()} WHERE message_id=${messageId} AND status='queued'`;
	}
}
