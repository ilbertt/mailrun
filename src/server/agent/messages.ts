import { withDatabase } from "../db";
import { requireToolAccess } from "./access";
import type { AgentToolContext } from "./types";
import type { INativeAgentMessageResult } from "../../queries.gen";
export type AgentMessage = INativeAgentMessageResult;
export async function ownToolMessage(ctx: AgentToolContext, messageId: string) {
	await requireToolAccess(ctx);
	const [row] = await withDatabase(
		(sql) =>
			sql.NativeAgentMessage`SELECT * FROM messages WHERE id=${messageId} AND mailbox_id=${ctx.mailboxId} AND (status!='draft' OR user_id=${ctx.user.id})`,
	);
	if (!row) throw new Error("Message not found");
	return row;
}
export function publicToolMessage(
	row: Pick<
		AgentMessage,
		| "id"
		| "mailbox_id"
		| "from_addr"
		| "to_addr"
		| "cc_addr"
		| "subject"
		| "snippet"
		| "direction"
		| "status"
		| "read"
		| "starred"
		| "thread_id"
		| "created_at"
	>,
) {
	return {
		id: row.id,
		mailboxId: row.mailbox_id,
		from: row.from_addr,
		to: row.to_addr,
		cc: row.cc_addr,
		subject: row.subject,
		snippet: row.snippet,
		direction: row.direction,
		status: row.status,
		read: !!row.read,
		starred: !!row.starred,
		threadId: row.thread_id,
		url: `/${row.status === "draft" ? "drafts" : row.status === "received" ? "inbox" : row.status}/${encodeURIComponent(row.id)}`,
		createdAt: new Date(row.created_at * 1000),
	};
}
