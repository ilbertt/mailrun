import type { AgentFetch } from "./provider";
import { withDatabase } from "../db";
import { getAgentEnabled, getAgentModel, recordAiUsage } from "./provider";
import { normalizeTimeZone } from "../../lib/time/utils";
import { requireToolAccess } from "./access";
import {
	startAgentTurn,
	saveAgentChatMessage,
	finishAgentTurn,
} from "./conversations";
import { agentSystemPrompt, agentCurrentEmailContext } from "./prompts";
import { agentProviderErrorMessage } from "./errors";
import {
	EMAIL_TOOL_NAMES,
	emailToolDescriptions,
	emailToolSchemas,
	runEmailTool,
} from "./tools";
import {
	CALENDAR_TOOL_NAMES,
	calendarToolDescriptions,
	calendarToolSchemas,
	runCalendarTool,
} from "../calendar/tools";
import type { AgentToolContext } from "./types";
export async function createAgentChatStream(
	context: AgentToolContext,
	text: string,
	conversationId?: string,
	signal?: AbortSignal,
	timeZone?: string,
	currentMessageId?: string,
	request: AgentFetch = fetch,
) {
	const zone = normalizeTimeZone(timeZone ?? context.timeZone),
		abort = new AbortController(),
		onAbort = () => abort.abort(signal?.reason);
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) onAbort();
	const ctx = { ...context, timeZone: zone, signal: abort.signal };
	try {
		await requireToolAccess(ctx);
		if (!(await getAgentEnabled())) throw new Error("Assistant is disabled");
		const [settings] = await withDatabase(
				(sql) =>
					sql.NativeChatMailboxPreferences`SELECT model_id,instructions FROM mailbox_agent_settings WHERE mailbox_id=${ctx.mailboxId}`,
			),
			selection = await getAgentModel(settings?.model_id, request);
		if (!selection) throw new Error("AI provider is not configured");
		const [current] = currentMessageId
				? await withDatabase(
						(sql) =>
							sql.NativeChatCurrentEmail`SELECT id FROM messages WHERE id=${currentMessageId} AND mailbox_id=${ctx.mailboxId} AND (status!='draft' OR user_id=${ctx.user.id})`,
					)
				: [],
			turn = await startAgentTurn(ctx, text, conversationId);
		const messages = [
			...turn.prompt,
			{
				role: "user" as const,
				content: current
					? `${text}\n\n(${agentCurrentEmailContext(current.id)})`
					: text,
			},
		];
		const tools = Object.fromEntries(
			EMAIL_TOOL_NAMES.map((name) => [
				name,
				{
					description: emailToolDescriptions[name],
					inputSchema: emailToolSchemas[name],
					execute: (input: unknown) => runEmailTool(ctx, name, input),
				},
			]),
		);
		const calendarTools = Object.fromEntries(
			CALENDAR_TOOL_NAMES.map((name) => [
				name,
				{
					description: calendarToolDescriptions[name],
					inputSchema: calendarToolSchemas[name],
					execute: (input: unknown) => runCalendarTool(ctx, name, input),
				},
			]),
		);
		const { streamText, stepCountIs } = await import("ai");
		const result = streamText({
				model: selection.model,
				system: agentSystemPrompt(settings?.instructions ?? "", zone),
				messages,
				tools: { ...tools, ...calendarTools },
				stopWhen: stepCountIs(7),
				maxOutputTokens: 1200,
				abortSignal: abort.signal,
				onError: ({ error }) =>
					console.error(
						"Assistant provider request failed",
						selection.errorMessage(error),
					),
				onStepFinish: async ({ usage }) => {
					await recordAiUsage(selection, usage, "chat");
				},
			}),
			encoder = new TextEncoder();
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				let response = "",
					stepText = "",
					reasoning = "";
				const emit = (event: unknown) => {
					if (!cancelled && !abort.signal.aborted)
						controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
				};
				emit({ type: "conversation", conversationId: turn.conversationId });
				try {
					for await (const part of result.fullStream) {
						if (part.type === "text-delta") {
							response += part.text;
							stepText += part.text;
							emit({ type: "text", text: part.text });
						} else if (part.type === "reasoning-delta") {
							reasoning += part.text;
							emit({ type: "reasoning", text: part.text });
						} else if (part.type === "finish-step") {
							if (part.finishReason === "tool-calls" && stepText) {
								response = response.slice(0, -stepText.length);
								reasoning += stepText;
								emit({ type: "reclassify", text: stepText });
							}
							stepText = "";
						} else if (part.type === "tool-call")
							emit({
								type: "tool",
								id: part.toolCallId,
								name: part.toolName,
								state: "running",
							});
						else if (part.type === "tool-result") {
							const json = JSON.stringify(part.output) ?? "null",
								proposal =
									part.output &&
									typeof part.output === "object" &&
									"status" in part.output &&
									part.output.status === "pending_approval",
								recordId = await saveAgentChatMessage(
									ctx,
									turn.conversationId,
									"tool",
									proposal ? json : json.slice(0, 12000),
									part.toolName,
								);
							emit({
								type: "tool",
								id: part.toolCallId,
								name: part.toolName,
								state: "complete",
								result: part.output,
								recordId,
							});
						} else if (part.type === "tool-error") {
							const message = selection.errorMessage(part.error);
							await saveAgentChatMessage(
								ctx,
								turn.conversationId,
								"tool",
								message,
								part.toolName,
							);
							emit({
								type: "tool",
								id: part.toolCallId,
								name: part.toolName,
								state: "failed",
								result: message,
							});
						} else if (part.type === "error")
							emit({
								type: "error",
								message: selection.errorMessage(part.error),
							});
						if (response.length + reasoning.length > 256000)
							throw new Error("AI provider response exceeds the allowed size");
					}
					if (reasoning.trim())
						await saveAgentChatMessage(
							ctx,
							turn.conversationId,
							"tool",
							reasoning.slice(0, 20000),
							"__reasoning__",
						);
					if (response.trim())
						await saveAgentChatMessage(
							ctx,
							turn.conversationId,
							"assistant",
							response,
						);
					await finishAgentTurn(ctx, turn.conversationId);
					emit({ type: "done" });
				} catch (error) {
					try {
						if (reasoning.trim())
							await saveAgentChatMessage(
								ctx,
								turn.conversationId,
								"tool",
								reasoning.slice(0, 20000),
								"__reasoning__",
							);
						if (response.trim())
							await saveAgentChatMessage(
								ctx,
								turn.conversationId,
								"assistant",
								response,
							);
					} catch {}
					emit({ type: "error", message: selection.errorMessage(error) });
				} finally {
					signal?.removeEventListener("abort", onAbort);
					abort.abort();
					if (!cancelled) controller.close();
				}
			},
			cancel(reason) {
				cancelled = true;
				abort.abort(reason);
				signal?.removeEventListener("abort", onAbort);
			},
		});
		return { conversationId: turn.conversationId, stream };
	} catch (error) {
		signal?.removeEventListener("abort", onAbort);
		abort.abort();
		throw error;
	}
}
