import { z } from "zod";
import { withDatabase } from "../db";
import type { User } from "../../shared/contracts";
import { withToolMutation } from "./access";
import { applyAgentMoves } from "./organize";
import { discardAgentDraftRows } from "./drafts";
import { draftLock } from "../mail/drafts";
import { deleteUnreferencedObjects } from "../storage";
const proposalSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("move_email"),
		status: z.literal("pending_approval"),
		emailIds: z.array(z.string()).length(1),
		destination: z.enum(["inbox", "archived", "trash", "spam"]),
	}),
	z.object({
		action: z.literal("move_emails"),
		status: z.literal("pending_approval"),
		emailIds: z.array(z.string()).min(1).max(20),
		destination: z.enum(["inbox", "archived", "trash", "spam"]),
	}),
	z.object({
		action: z.literal("mark_email_read"),
		status: z.literal("pending_approval"),
		emailId: z.string(),
		read: z.boolean(),
	}),
	z.object({
		action: z.literal("discard_draft"),
		status: z.literal("pending_approval"),
		draftId: z.string(),
		expectedRevision: z.number().int().positive(),
	}),
]);
export async function confirmAgentAction(user: User, toolMessageId: string) {
	const [original] = await withDatabase(
		(sql) =>
			sql.NativeAgentActionLookup`SELECT m.content,m.tool_name,c.mailbox_id FROM agent_chat_messages m JOIN agent_conversations c ON c.id=m.conversation_id WHERE m.id=${toolMessageId} AND m.role='tool' AND c.user_id=${user.id}`,
	);
	if (!original) throw new Error("Action not found");
	let raw: Record<string, unknown>;
	try {
		raw = z.record(z.string(), z.unknown()).parse(JSON.parse(original.content));
	} catch {
		throw new Error("Action is unavailable or already approved");
	}
	const proposal = proposalSchema.safeParse(raw);
	if (!proposal.success || original.tool_name !== proposal.data.action)
		throw new Error("Action is unavailable or already approved");
	const action = proposal.data,
		ctx = { user, mailboxId: original.mailbox_id, origin: "chat" as const };
	const run = () =>
		withToolMutation(
			ctx,
			action.action === "mark_email_read"
				? "read"
				: action.action === "discard_draft"
					? "send"
					: "manage",
			async (sql) => {
				const [claim] =
					await sql.NativeAgentActionClaim`SELECT m.id FROM agent_chat_messages m JOIN agent_conversations c ON c.id=m.conversation_id WHERE m.id=${toolMessageId} AND c.user_id=${user.id} AND c.mailbox_id=${ctx.mailboxId} AND m.role='tool' AND m.tool_name=${action.action} AND m.content=${original.content}`;
				if (!claim) throw new Error("Action is already being processed");
				let keys: string[] = [],
					result: Record<string, unknown>;
				if (action.action === "mark_email_read") {
					const [changed] =
						await sql.NativeAgentApproveRead`UPDATE messages SET read=${action.read ? 1 : 0} WHERE id=${action.emailId} AND mailbox_id=${ctx.mailboxId} AND (status!='draft' OR user_id=${user.id}) RETURNING id`;
					if (!changed) throw new Error("Message not found");
					result = { emailId: action.emailId, read: action.read };
				} else if (action.action === "discard_draft") {
					keys = await discardAgentDraftRows(
						sql,
						ctx,
						action.draftId,
						action.expectedRevision,
					);
					result = { draftId: action.draftId, status: "discarded" };
				} else {
					const ids = [...new Set(action.emailIds)];
					await applyAgentMoves(sql, ctx, ids, action.destination);
					result = {
						emailIds: ids,
						destination: action.destination,
						status: "approved",
					};
				}
				const updated = { ...raw, status: "approved", result };
				await sql.NativeAgentActionComplete`UPDATE agent_chat_messages SET content=${JSON.stringify(updated)} WHERE id=${toolMessageId} AND content=${original.content}`;
				return { updated, keys };
			},
		);
	// Claim, mutation and recorded result commit together. A crash cannot strand
	// a proposal in "processing" or replay a mutation after it already committed.
	const completed =
		action.action === "discard_draft"
			? await draftLock(action.draftId, run)
			: await run();
	await deleteUnreferencedObjects(completed.keys).catch((error) =>
		console.warn("Approved action file cleanup failed", error),
	);
	return completed.updated;
}
