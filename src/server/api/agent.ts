import type { AgentFetch } from "../agent/provider";
import { z } from "zod";
import { withDatabase, seconds } from "../db";
import type { User } from "../../shared/contracts";
import { readLimitedBody } from "../mail/inbound";
import { mailboxAccess } from "../mail/access";
import {
	getAgentEnabled,
	getAgentProviderPublicConfig,
	primaryAgentAdmin,
	setAgentEnabled,
	agentProviderSchema,
	saveAgentProvider,
	CLOUDFLARE_TOOL_MODELS,
	listCompatibleAgentModels,
} from "../agent/provider";
import {
	getMailboxAgentSettings,
	saveMailboxAgentSettings,
	mailboxAgentSchema,
} from "../agent/settings";
import {
	listAgentConversations,
	getAgentChatHistory,
	deleteAgentConversation,
} from "../agent/conversations";
import { withToolMutation } from "../agent/access";
const json = (value: unknown, status = 200) =>
	Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
async function body(request: Request) {
	try {
		return JSON.parse(
			new TextDecoder().decode(await readLimitedBody(request, 32 * 1024)),
		) as unknown;
	} catch {
		return null;
	}
}
const catalogSchema = z.object({
	provider: z.enum(["cloudflare", "compatible"]),
	preset: z.enum(["openai", "openrouter", "groq", "custom"]),
	baseUrl: z.string().max(500),
	apiKey: z.string().max(2000).optional(),
});
export async function agentApi(
	request: Request,
	user: User,
	modelFetch: AgentFetch = fetch,
): Promise<Response | null> {
	const url = new URL(request.url),
		path = url.pathname,
		method = request.method;
	if (path === "/api/agent/availability" && method === "GET")
		return json({ enabled: await getAgentEnabled() });
	if (path === "/api/admin/agent" || path === "/api/admin/agent/models") {
		await withDatabase((sql) => primaryAgentAdmin(sql, user));
		if (path.endsWith("/models") && method === "POST") {
			const parsed = catalogSchema.safeParse(await body(request));
			if (!parsed.success)
				return json({ error: "Invalid provider details" }, 400);
			try {
				return json(
					parsed.data.provider === "cloudflare"
						? { models: CLOUDFLARE_TOOL_MODELS, source: "suggested" }
						: await listCompatibleAgentModels(parsed.data, modelFetch),
				);
			} catch (error) {
				return json(
					{
						error:
							error instanceof Error ? error.message : "Unable to load models",
					},
					400,
				);
			}
		}
		if (path.endsWith("/models"))
			return new Response(null, { status: 405, headers: { Allow: "POST" } });
		if (method === "GET")
			return json({
				config: await getAgentProviderPublicConfig(),
				assistantEnabled: await getAgentEnabled(),
				cloudflareAvailable: false,
			});
		if (method === "PUT") {
			const raw = await body(request),
				enabled = z.object({ enabled: z.boolean() }).safeParse(raw);
			if (
				enabled.success &&
				raw &&
				typeof raw === "object" &&
				Object.keys(raw).length === 1
			) {
				await setAgentEnabled(user, enabled.data.enabled);
				return json({ assistantEnabled: enabled.data.enabled });
			}
			const parsed = agentProviderSchema.safeParse(raw);
			if (!parsed.success)
				return json({ error: "Invalid provider settings" }, 400);
			try {
				await saveAgentProvider(user, parsed.data);
				return json({
					config: await getAgentProviderPublicConfig(),
					assistantEnabled: await getAgentEnabled(),
					cloudflareAvailable: false,
				});
			} catch (error) {
				if (error instanceof Response) throw error;
				return json(
					{
						error:
							error instanceof Error
								? error.message
								: "Invalid provider settings",
					},
					400,
				);
			}
		}
		return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
	}
	if (path === "/api/agent/settings") {
		if (method === "GET") {
			const mailboxId = url.searchParams.get("mailboxId");
			if (!mailboxId) return json({ error: "Mailbox required" }, 400);
			try {
				return json(await getMailboxAgentSettings(user, mailboxId));
			} catch {
				return json({ error: "Mailbox not found" }, 404);
			}
		}
		if (method === "PUT") {
			const parsed = mailboxAgentSchema.safeParse(await body(request));
			if (!parsed.success) return json({ error: "Invalid settings" }, 400);
			try {
				await mailboxAccess(user, parsed.data.mailboxId, "manage");
			} catch {
				return json({ error: "Mailbox not found or permission denied" }, 403);
			}
			try {
				await saveMailboxAgentSettings(user, parsed.data);
				return json({ ok: true });
			} catch (error) {
				return json(
					{
						error: error instanceof Error ? error.message : "Invalid settings",
					},
					400,
				);
			}
		}
	}
	if (path === "/api/agent/conversations" && method === "GET") {
		const box = url.searchParams.get("mailboxId");
		if (!box) return json({ error: "Mailbox required" }, 400);
		try {
			return json({
				conversations: await listAgentConversations({
					user,
					mailboxId: box,
					origin: "chat",
				}),
			});
		} catch {
			return json({ error: "Mailbox not found" }, 404);
		}
	}
	const conversation = /^\/api\/agent\/conversations\/([^/]+)$/.exec(path);
	if (conversation) {
		const id = decodeURIComponent(conversation[1]!);
		if (method === "GET") {
			const box = url.searchParams.get("mailboxId");
			if (!box) return json({ error: "Mailbox required" }, 400);
			try {
				return json({
					messages: await getAgentChatHistory(
						{ user, mailboxId: box, origin: "chat" },
						id,
					),
				});
			} catch {
				return json({ error: "Conversation not found" }, 404);
			}
		}
		if (method === "DELETE") {
			const [row] = await withDatabase(
				(sql) =>
					sql.NativeAgentDeleteConversationContext`SELECT mailbox_id FROM agent_conversations WHERE id=${id} AND user_id=${user.id}`,
			);
			if (row)
				await deleteAgentConversation(
					{ user, mailboxId: row.mailbox_id, origin: "chat" },
					id,
				);
			return json({ ok: true });
		}
	}
	if (path === "/api/agent/actions/confirm" && method === "POST") {
		const parsed = z
			.object({ toolMessageId: z.string().min(1) })
			.safeParse(await body(request));
		if (!parsed.success) return json({ error: "Invalid request" }, 400);
		try {
			const { confirmAgentAction } = await import("../agent/actions");
			return json(await confirmAgentAction(user, parsed.data.toolMessageId));
		} catch (error) {
			return json(
				{
					error:
						error instanceof Error ? error.message : "Could not approve action",
				},
				409,
			);
		}
	}
	if (path === "/api/agent/jobs" && method === "GET") {
		const box = url.searchParams.get("mailboxId");
		try {
			if (!box) throw new Error();
			await mailboxAccess(user, box);
		} catch {
			return json({ error: "Mailbox not found" }, 404);
		}
		const rows = await withDatabase(
			(sql) =>
				sql.NativeAgentJobsList`SELECT id,status,reason,draft_id,source_message_id,created_at FROM agent_jobs WHERE mailbox_id=${box!} AND reviewer_user_id=${user.id} ORDER BY created_at DESC,rowid LIMIT 30`,
		);
		return json({
			jobs: rows.map((row) => ({
				id: row.id,
				status: row.status,
				reason: row.reason,
				draftId: row.draft_id,
				sourceMessageId: row.source_message_id,
				createdAt: new Date(row.created_at * 1000),
			})),
		});
	}
	const retry = /^\/api\/agent\/jobs\/([^/]+)\/retry$/.exec(path);
	if (retry && method === "POST") {
		const id = decodeURIComponent(retry[1]!),
			[job] = await withDatabase(
				(sql) =>
					sql.NativeAgentRetryLookup`SELECT mailbox_id,reviewer_user_id,status FROM agent_jobs WHERE id=${id}`,
			);
		if (!job || job.reviewer_user_id !== user.id)
			return json({ error: "Job not found" }, 404);
		try {
			await mailboxAccess(user, job.mailbox_id, "send");
		} catch {
			return json({ error: "Job not found" }, 404);
		}
		if (job.status !== "failed")
			return json({ error: "Job cannot be retried" }, 409);
		await withToolMutation(
			{ user, mailboxId: job.mailbox_id, origin: "chat" },
			"send",
			async (sql) => {
				const [updated] =
					await sql.NativeRetryAgentJob`UPDATE agent_jobs SET status='pending',attempts=0,next_attempt_at=${seconds()},lease_until=NULL,reason=NULL WHERE id=${id} AND reviewer_user_id=${user.id} AND status='failed' RETURNING id`;
				if (!updated)
					throw new Response("Job cannot be retried", { status: 409 });
			},
		);
		const { wakeAgentDispatcher } = await import("../agent/dispatcher");
		wakeAgentDispatcher();
		return json({ ok: true });
	}
	return null;
}
