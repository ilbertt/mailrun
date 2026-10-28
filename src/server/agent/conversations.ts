import { withDatabase, id, seconds } from "../db";
import {
	requireToolAccess,
	withToolMutation,
	withToolUserMutation,
} from "./access";
import type { AgentToolContext } from "./types";
import type { INativeAgentConversationResult } from "../../queries.gen";
const dto = (row: INativeAgentConversationResult) => ({
	id: row.id,
	userId: row.user_id,
	mailboxId: row.mailbox_id,
	title: row.title,
	createdAt: new Date(row.created_at * 1000),
	updatedAt: new Date(row.updated_at * 1000),
});
export async function getAgentConversation(
	ctx: AgentToolContext,
	conversationId: string,
) {
	await requireToolAccess(ctx);
	const [row] = await withDatabase(
		(sql) =>
			sql.NativeAgentConversation`SELECT * FROM agent_conversations WHERE id=${conversationId} AND user_id=${ctx.user.id} AND mailbox_id=${ctx.mailboxId}`,
	);
	return row ? dto(row) : null;
}
export async function listAgentConversations(ctx: AgentToolContext) {
	await requireToolAccess(ctx);
	const rows = await withDatabase(
		(sql) =>
			sql.NativeAgentConversationList`SELECT * FROM agent_conversations WHERE user_id=${ctx.user.id} AND mailbox_id=${ctx.mailboxId} ORDER BY updated_at DESC,rowid LIMIT 30`,
	);
	return rows.map(dto);
}
export async function getAgentChatHistory(
	ctx: AgentToolContext,
	conversationId: string,
) {
	if (!(await getAgentConversation(ctx, conversationId)))
		throw new Error("Conversation not found");
	const rows = await withDatabase(
		(sql) =>
			sql.NativeAgentChatHistory`SELECT * FROM agent_chat_messages WHERE conversation_id=${conversationId} ORDER BY created_at,rowid LIMIT 200`,
	);
	return rows.map((row) => ({
		id: row.id,
		conversationId: row.conversation_id,
		role: row.role,
		content: row.content,
		toolName: row.tool_name,
		createdAt: new Date(row.created_at * 1000),
	}));
}
export async function startAgentTurn(
	ctx: AgentToolContext,
	text: string,
	conversationId?: string,
) {
	await requireToolAccess(ctx);
	const convId = conversationId ?? id("conv");
	return withToolMutation(ctx, "read", async (sql) => {
		if (!conversationId)
			await sql.NativeCreateAgentConversation`INSERT INTO agent_conversations(id,user_id,mailbox_id,title,created_at,updated_at) VALUES(${convId},${ctx.user.id},${ctx.mailboxId},${text.slice(0, 80)},${seconds()},${seconds()})`;
		const [current] =
			await sql.NativeAgentTurnConversation`SELECT id FROM agent_conversations WHERE id=${convId} AND user_id=${ctx.user.id} AND mailbox_id=${ctx.mailboxId}`;
		if (!current) throw new Error("Conversation not found");
		const history =
			await sql.NativeAgentPromptHistory`SELECT role,content FROM agent_chat_messages WHERE conversation_id=${convId} ORDER BY created_at DESC,rowid DESC LIMIT 30`;
		await sql.NativeAgentUserMessage`INSERT INTO agent_chat_messages(id,conversation_id,role,content,created_at) VALUES(${id("chat")},${convId},'user',${text},${seconds()})`;
		return {
			conversationId: convId,
			prompt: history
				.reverse()
				.flatMap((row) =>
					row.role === "user" || row.role === "assistant"
						? [{ role: row.role as "user" | "assistant", content: row.content }]
						: [],
				),
		};
	});
}
export async function saveAgentChatMessage(
	ctx: AgentToolContext,
	conversationId: string,
	role: "assistant" | "tool",
	content: string,
	toolName: string | null = null,
) {
	const messageId = id("chat");
	await withToolMutation({ ...ctx, signal: undefined }, "read", async (sql) => {
		const [row] =
			await sql.NativeAgentPersistMessage`INSERT INTO agent_chat_messages(id,conversation_id,role,content,tool_name,created_at) SELECT ${messageId},c.id,${role},${content},${toolName},${seconds()} FROM agent_conversations c WHERE c.id=${conversationId} AND c.user_id=${ctx.user.id} AND c.mailbox_id=${ctx.mailboxId} RETURNING id`;
		if (!row) throw new Error("Conversation not found");
	});
	return messageId;
}
export async function finishAgentTurn(
	ctx: AgentToolContext,
	conversationId: string,
) {
	await withDatabase(
		(sql) =>
			sql.NativeAgentFinishTurn`UPDATE agent_conversations SET updated_at=${seconds()} WHERE id=${conversationId} AND user_id=${ctx.user.id} AND mailbox_id=${ctx.mailboxId}`,
	);
}
export async function deleteAgentConversation(
	ctx: AgentToolContext,
	conversationId: string,
) {
	await withToolUserMutation(ctx, async (sql) => {
		await sql.NativeDeleteAgentConversation`DELETE FROM agent_conversations WHERE id=${conversationId} AND user_id=${ctx.user.id} AND mailbox_id=${ctx.mailboxId}`;
	});
}
