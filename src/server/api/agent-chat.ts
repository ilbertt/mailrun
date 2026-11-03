import type { AgentFetch } from "../agent/provider";
import { z } from "zod";
import { serveSessionApi } from "./session";
import { readLimitedBody } from "../mail/inbound";
import { allowAgentRequest } from "../agent/rate-limit";
import { agentProviderErrorMessage } from "../agent/errors";
import { getRequestTimeZone } from "../../lib/time/utils";
import { withDatabase } from "../db";
const schema = z.object({
	mailboxId: z.string().min(1),
	conversationId: z.string().nullish(),
	text: z.string().trim().min(1).max(4000),
	timeZone: z.string().max(80).optional(),
	currentMessageId: z.string().max(100).nullish(),
});
export function serveAgentChat(
	request: Request,
	onAuthenticated?: () => void,
	modelFetch: AgentFetch = fetch,
) {
	return serveSessionApi(request, async (request, user) => {
		if (request.method !== "POST")
			return new Response(null, { status: 405, headers: { Allow: "POST" } });
		if (!allowAgentRequest(`chat:${user.id}`))
			return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
		const raw = await readLimitedBody(request, 8000)
				.then((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown)
				.catch(() => null),
			parsed = schema.safeParse(raw);
		if (!parsed.success)
			return Response.json({ error: "Invalid request" }, { status: 400 });
		try {
			onAuthenticated?.();
			const [profile] = await withDatabase(
					(sql) =>
						sql.NativeAgentChatTimeZone`SELECT time_zone FROM users WHERE id=${user.id}`,
				),
				{ createAgentChatStream } = await import("../agent/chat"),
				result = await createAgentChatStream(
					{ user, mailboxId: parsed.data.mailboxId, origin: "chat" },
					parsed.data.text,
					parsed.data.conversationId ?? undefined,
					request.signal,
					getRequestTimeZone(request, profile?.time_zone),
					parsed.data.currentMessageId ?? undefined,
					modelFetch,
				);
			return new Response(result.stream, {
				headers: {
					"Content-Type": "application/x-ndjson; charset=utf-8",
					"Cache-Control": "no-store",
					"X-Conversation-Id": result.conversationId,
				},
			});
		} catch (error) {
			return Response.json(
				{ error: agentProviderErrorMessage(error) },
				{ status: 400 },
			);
		}
	});
}
