import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { withDatabase, seconds } from "../db";
import { listMailboxes } from "../mail/repository";
import { draftLock } from "../mail/drafts";
import {
	runEmailTool,
	EMAIL_TOOL_NAMES,
	emailToolDescriptions,
	emailToolSchemas,
} from "../agent/tools";
import { editAgentDraft } from "../agent/drafts";
import { requestAgentSend, getAgentSendRequest } from "../agent/approvals";
import {
	CALENDAR_TOOL_NAMES,
	calendarToolDescriptions,
	calendarToolSchemas,
	calendarToolScope,
	runCalendarTool,
} from "../calendar/tools";
import { registerAdminMcpTools } from "./admin-tools";
import { requireMcpScope, type McpPrincipal } from "./auth";
import { withToolMutation } from "../agent/access";
import type { EmailToolName, AgentToolContext } from "../agent/types";
const scopeByTool: Record<EmailToolName, string> = {
	list_emails: "mcp:read",
	get_email: "mcp:read",
	get_thread: "mcp:read",
	search_emails: "mcp:read",
	draft_email: "mcp:draft",
	draft_reply: "mcp:draft",
	edit_draft: "mcp:draft",
	review_draft_send: "mcp:request-send",
	mark_email_read: "mcp:organize",
	move_email: "mcp:organize",
	move_emails: "mcp:organize",
	discard_draft: "mcp:draft",
};
const output = (value: unknown, isError = false) => ({
	content: [{ type: "text" as const, text: JSON.stringify(value) }],
	isError,
});
async function safely(run: () => Promise<unknown>) {
	try {
		return output(await run());
	} catch (error) {
		return output(
			{ error: error instanceof Error ? error.message : "Permission denied" },
			true,
		);
	}
}
export function createMailflareMcpHandler(
	principal: McpPrincipal,
	baseUrl: string,
	authorization: string,
) {
	return createMcpHandler(
		() => {
			const server = new McpServer({ name: "mailflare", version: "0.1.0" });
			const context = async (
				scope: string,
				mailboxId: string,
			): Promise<AgentToolContext> => ({
				user: principal.user,
				mailboxId,
				origin: "mcp",
				timeZone: principal.timeZone,
				actor: await requireMcpScope(principal, scope, mailboxId),
			});
			if (principal.scopes.some((scope) => scope.startsWith("mcp:"))) {
				for (const name of CALENDAR_TOOL_NAMES)
					server.registerTool(
						name,
						{
							description: calendarToolDescriptions[name],
							inputSchema: calendarToolSchemas[name],
						},
						(args: z.infer<(typeof calendarToolSchemas)[typeof name]>) =>
							safely(async () =>
								runCalendarTool(
									{
										user: principal.user,
										timeZone: principal.timeZone,
										actor: await requireMcpScope(
											principal,
											calendarToolScope(name),
										),
									},
									name,
									args,
								),
							),
					);
				server.registerTool(
					"list_mailboxes",
					{
						description: "List mailboxes allowed for this key",
						inputSchema: z.object({}),
					},
					() =>
						safely(async () => {
							await requireMcpScope(principal, "mcp:read");
							const boxes = await listMailboxes(principal.user),
								grants = await withDatabase(
									(sql) =>
										sql.NativeMcpListMailboxGrants`SELECT mailbox_id FROM mcp_key_mailboxes WHERE key_id=${principal.keyId}`,
								),
								allowed = new Set(grants.map((row) => row.mailbox_id));
							return boxes
								.filter(
									(box) =>
										principal.mailboxIds.includes(box.id) &&
										allowed.has(box.id),
								)
								.map((box) => ({
									id: box.id,
									address: `${box.local_part}@${box.hostname}`,
									displayName: box.display_name,
								}));
						}),
				);
				for (const name of EMAIL_TOOL_NAMES) {
					if (name === "edit_draft" || name === "review_draft_send") continue;
					server.registerTool(
						name,
						{
							description: emailToolDescriptions[name],
							inputSchema: z.object({
								mailboxId: z.string().min(1),
								...emailToolSchemas[name].shape,
							}),
						},
						(args) =>
							safely(async () =>
								runEmailTool(
									await context(scopeByTool[name], args.mailboxId),
									name,
									args,
								),
							),
					);
				}
				server.registerTool(
					"update_draft",
					{
						description: emailToolDescriptions.edit_draft,
						inputSchema: z.object({
							mailboxId: z.string(),
							...emailToolSchemas.edit_draft.shape,
						}),
					},
					(args) =>
						safely(async () =>
							editAgentDraft(await context("mcp:draft", args.mailboxId), args),
						),
				);
				server.registerTool(
					"request_send",
					{
						description: "Request human review of a draft; this never sends",
						inputSchema: z.object({
							mailboxId: z.string(),
							draftId: z.string(),
							expectedRevision: z.number().int().positive(),
						}),
					},
					(args) =>
						safely(async () => {
							const ctx = await context("mcp:request-send", args.mailboxId),
								result = await requestAgentSend(
									ctx,
									args.draftId,
									args.expectedRevision,
									principal.keyId,
								);
							return {
								...result,
								reviewUrl: new URL(result.reviewUrl, baseUrl).toString(),
							};
						}),
				);
				server.registerTool(
					"get_scheduled_send",
					{
						description:
							"Get when a scheduled email (from the scheduled folder) will be sent.",
						inputSchema: z.object({
							mailboxId: z.string(),
							messageId: z.string(),
						}),
					},
					(args) =>
						safely(async () => {
							await context("mcp:read", args.mailboxId);
							const [row] = await withDatabase(
								(sql) =>
									sql.NativeMcpScheduledTime`SELECT min(j.scheduled_at) AS scheduled_at FROM outbound_jobs j JOIN messages m ON m.id=j.message_id WHERE m.id=${args.messageId} AND m.mailbox_id=${args.mailboxId} AND m.status='queued' AND j.status='queued' AND j.scheduled_at IS NOT NULL`,
							);
							if (row?.scheduled_at == null)
								throw new Error("Scheduled email not found");
							return {
								messageId: args.messageId,
								scheduledAt: new Date(
									Number(row.scheduled_at) * 1000,
								).toISOString(),
							};
						}),
				);
				server.registerTool(
					"cancel_scheduled_send",
					{
						description:
							"Cancel a scheduled email before it is sent. It returns to Drafts and is not sent.",
						inputSchema: z.object({
							mailboxId: z.string(),
							messageId: z.string(),
						}),
					},
					(args) =>
						safely(async () => {
							const ctx = await context("mcp:draft", args.mailboxId);
							await draftLock(args.messageId, () =>
								withToolMutation(ctx, "send", async (sql) => {
									const [row] =
										await sql.NativeMcpCancelScheduledGuard`SELECT id FROM messages WHERE id=${args.messageId} AND mailbox_id=${args.mailboxId} AND status='queued'`;
									if (!row) throw new Error("Scheduled email not found");
									const jobs =
										await sql.NativeMcpCancelScheduledJob`DELETE FROM outbound_jobs WHERE message_id=${args.messageId} AND status='queued' AND scheduled_at IS NOT NULL RETURNING id`;
									if (!jobs.length)
										throw new Error("This email is already being sent");
									await sql.NativeMcpCancelScheduledMessage`UPDATE messages SET status='draft',draft_scheduled_at=NULL,draft_revision=draft_revision+1 WHERE id=${args.messageId} AND mailbox_id=${args.mailboxId} AND status='queued'`;
								}),
							);
							return {
								messageId: args.messageId,
								status: "cancelled",
								draftId: args.messageId,
							};
						}),
				);
				server.registerTool(
					"get_send_request",
					{
						description: "Read the status of this key's send review request",
						inputSchema: z.object({ approvalId: z.string() }),
					},
					(args) =>
						safely(async () => {
							await requireMcpScope(principal, "mcp:request-send");
							const [row] = await withDatabase(
								(sql) =>
									sql.NativeMcpApprovalKey`SELECT mailbox_id FROM agent_send_approvals WHERE id=${args.approvalId} AND request_key_id=${principal.keyId} AND user_id=${principal.user.id}`,
							);
							if (!row) throw new Error("Request not found");
							await requireMcpScope(
								principal,
								"mcp:request-send",
								row.mailbox_id,
							);
							return getAgentSendRequest(principal.user, args.approvalId);
						}),
				);
			}
			registerAdminMcpTools(server, principal, baseUrl, authorization);
			return server;
		},
		{ responseMode: "json" },
	);
}
