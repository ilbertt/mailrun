import PostalMime from "postal-mime";
import { readMailHeaderBlock } from "../src/server/mail/header-block";
import {
	test,
	expect,
	beforeEach,
	afterEach,
	spyOn,
	setSystemTime,
} from "bun:test";
import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { fixture, owner, stranger, enableTeamSharing } from "./fixtures";
import { withDatabase, seconds } from "../src/server/db";
import { hash } from "../src/server/auth/service";
import { publicOrigin } from "../src/server/config";
import {
	getAgentEnabled,
	getAgentProviderConfig,
	getAgentProviderPublicConfig,
	saveAgentProvider,
	setAgentEnabled,
	listCompatibleAgentModels,
	type AgentFetch,
} from "../src/server/agent/provider";
import {
	getMailboxAgentSettings,
	saveMailboxAgentSettings,
} from "../src/server/agent/settings";
import { createAgentChatStream } from "../src/server/agent/chat";
import {
	getAgentChatHistory,
	listAgentConversations,
	deleteAgentConversation,
	saveAgentChatMessage,
	startAgentTurn,
} from "../src/server/agent/conversations";
import { confirmAgentAction } from "../src/server/agent/actions";
import { runEmailTool } from "../src/server/agent/tools";
import {
	enqueueAutoDraft,
	processAgentDraftJob,
	recoverAgentDraftJobs,
	isAutomaticMessage,
	type AutoDraftInput,
} from "../src/server/agent/jobs";
import {
	startAgentDispatcher,
	wakeAgentDispatcher,
} from "../src/server/agent/dispatcher";
import { getDraft } from "../src/server/mail/drafts";
import { storeInbound } from "../src/server/mail/inbound";
import { agentApi } from "../src/server/api/agent";
import { serveAgentChat } from "../src/server/api/agent-chat";
import { aiUsageApi } from "../src/server/api/ai-usage";
import { writeBackup, restoreBackup } from "../src/lib/backups/export";
import type { AgentToolContext } from "../src/server/agent/types";
let state: Awaited<ReturnType<typeof fixture>>;
const ctx: AgentToolContext = {
	user: owner,
	mailboxId: "mailbox",
	origin: "chat",
};
const privateKey = "fixture-provider-private-key";
beforeEach(async () => {
	state = await fixture();
});
afterEach(() => state.close());
const config = () => ({
	provider: "compatible" as const,
	preset: "custom" as const,
	baseUrl: "https://provider.example/v1",
	apiKey: privateKey,
	model: "fixture-model, second-model",
	rates: {
		"fixture-model": { input: 2, output: 4 },
		"second-model": { input: null, output: null },
	},
});
async function configure() {
	await saveAgentProvider(owner, config());
}
async function autoSettings(extra: Record<string, unknown> = {}) {
	await saveMailboxAgentSettings(owner, {
		mailboxId: "mailbox",
		enabled: true,
		autoDraftEnabled: true,
		reviewerUserId: "owner",
		instructions: "Be concise.",
		dailyLimit: 25,
		modelId: "fixture-model",
		...extra,
	});
}
const automaticInput = (
	extra: Partial<AutoDraftInput> = {},
): AutoDraftInput => ({
	mailboxId: "mailbox",
	sourceMessageId: "message",
	ownerUserId: "owner",
	sender: "sender@example.org",
	status: "received",
	folderId: null,
	...extra,
});
async function schedule(extra: Partial<AutoDraftInput> = {}) {
	return withDatabase((sql) =>
		sql.begin(async (sql) => {
			await sql`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
			return enqueueAutoDraft(sql, automaticInput(extra));
		}),
	);
}
const completion = (text = "Tuesday works for me.") =>
	Response.json({
		id: "fixture",
		object: "chat.completion",
		created: 1,
		model: "fixture-model",
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: text },
				finish_reason: "stop",
			},
		],
		usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
	});
function sse(deltas: Record<string, unknown>[], finish = "stop") {
	const chunks: {
		id: string;
		object: string;
		created: number;
		model: string;
		choices: {
			index: number;
			delta: Record<string, unknown>;
			finish_reason: string | null;
		}[];
	}[] = deltas.map((delta) => ({
		id: "fixture",
		object: "chat.completion.chunk",
		created: 1,
		model: "fixture-model",
		choices: [{ index: 0, delta, finish_reason: null }],
	}));
	chunks.push({
		id: "fixture",
		object: "chat.completion.chunk",
		created: 1,
		model: "fixture-model",
		choices: [
			{
				index: 0,
				delta: {},
				finish_reason: finish === "tool-calls" ? "tool_calls" : finish,
			},
		],
	});
	return new Response(
		chunks.map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n").join("") +
			"data: " +
			JSON.stringify({
				id: "fixture",
				object: "chat.completion.chunk",
				created: 1,
				model: "fixture-model",
				choices: [],
				usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
			}) +
			"\n\ndata: [DONE]\n\n",
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}
const inputBody = (init?: RequestInit) =>
	JSON.parse(String(init?.body ?? "{}")) as {
		model: string;
		stream?: boolean;
		messages: { role: string; content: unknown; tool_calls?: unknown }[];
		tools?: {
			function: { name: string; parameters: Record<string, unknown> };
		}[];
		max_tokens?: number;
	};
async function events(stream: ReadableStream<Uint8Array>) {
	return (await new Response(stream).text())
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}
const request = (path: string, method = "GET", body?: unknown) =>
	new Request(publicOrigin() + path, {
		method,
		headers: { Origin: publicOrigin(), "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
const bodyResponse = async (response: Response | null) => {
	if (!response) throw Error("Missing response");
	return { status: response.status, data: await response.json() };
};
test("provider settings keep the original self-hosted defaults, primary-only access and masked credential reuse", async () => {
	expect(await getAgentEnabled()).toBe(true);
	expect(await getAgentProviderPublicConfig()).toMatchObject({
		provider: "cloudflare",
		configured: false,
		hasApiKey: false,
		source: "default",
	});
	await expect(
		agentApi(request("/api/admin/agent"), stranger),
	).rejects.toMatchObject({ status: 403 });
	await expect(saveAgentProvider(stranger, config())).rejects.toMatchObject({
		status: 403,
	});
	await configure();
	const publicConfig = await getAgentProviderPublicConfig();
	expect(publicConfig).toMatchObject({
		provider: "compatible",
		configured: true,
		models: ["fixture-model", "second-model"],
		hasApiKey: true,
		source: "saved",
	});
	expect(JSON.stringify(publicConfig)).not.toContain(privateKey);
	await saveAgentProvider(owner, { ...config(), apiKey: "" });
	expect((await getAgentProviderConfig()).apiKey).toBe(privateKey);
	await expect(
		saveAgentProvider(owner, {
			...config(),
			baseUrl: "https://other.example/v1",
			apiKey: "",
		}),
	).rejects.toThrow("Enter an API key");
	await expect(
		saveAgentProvider(owner, { ...config(), provider: "cloudflare" }),
	).rejects.toThrow("binding is unavailable");
	await expect(
		saveAgentProvider(owner, {
			...config(),
			baseUrl: "http://provider.example/v1",
		}),
	).rejects.toThrow("valid HTTPS");
});
test("model discovery uses the saved endpoint key and reports published per-million prices", async () => {
	await saveAgentProvider(owner, {
		...config(),
		preset: "openrouter",
		baseUrl: "",
	});
	let seen = "";
	const models = await listCompatibleAgentModels(
		{ preset: "openrouter", baseUrl: "" },
		async (url, init) => {
			seen = String(url);
			expect(new Headers(init?.headers).get("authorization")).toBe(
				"Bearer " + privateKey,
			);
			expect(init?.redirect).toBe("manual");
			return Response.json({
				data: [
					{
						id: "z",
						name: "Z",
						pricing: { prompt: "0.000002", completion: "0.000004" },
					},
					{ id: "a", name: "A" },
				],
			});
		},
	);
	expect(seen).toBe("https://openrouter.ai/api/v1/models");
	expect(models.models.map((row) => row.id)).toEqual(["a", "z"]);
	expect(models.models[1]?.rates).toEqual({ input: 2, output: 4 });
	await expect(
		listCompatibleAgentModels(
			{ preset: "custom", baseUrl: "https://other.example/v1" },
			async () => {
				throw Error("Must not send key");
			},
		),
	).rejects.toThrow("Enter an API key");
});
test("mailbox agent settings retain models, reviewers, sharing roles and auto-reply exclusions", async () => {
	await configure();
	let settings = await getMailboxAgentSettings(owner, "mailbox");
	expect(settings).toMatchObject({
		canManage: true,
		canConfigureProvider: true,
		providerConfigured: true,
		settings: {
			enabled: true,
			autoDraftEnabled: false,
			reviewerUserId: "owner",
			dailyLimit: 25,
		},
	});
	await autoSettings({ enabled: false });
	expect(
		(await getMailboxAgentSettings(owner, "mailbox")).settings.enabled,
	).toBe(true);
	await expect(autoSettings({ modelId: "not-configured" })).rejects.toThrow(
		"configured model",
	);
	await expect(autoSettings({ reviewerUserId: "stranger" })).rejects.toThrow(
		"send permission",
	);
	enableTeamSharing(state.db);
	state.db.exec(
		"INSERT INTO mailbox_access(id,user_id,mailbox_id,permission,created_at) VALUES('share','stranger','mailbox','read_only',1)",
	);
	settings = await getMailboxAgentSettings(stranger, "mailbox");
	expect(settings.canManage).toBe(false);
	expect(settings.reviewers).toEqual([]);
	state.db.exec(
		"UPDATE mailbox_access SET permission='send_as' WHERE id='share'",
	);
	await autoSettings({ reviewerUserId: "stranger" });
	expect(
		(await getMailboxAgentSettings(owner, "mailbox")).settings.reviewerUserId,
	).toBe("stranger");
	state.db.exec("UPDATE mailboxes SET auto_reply_enabled=1 WHERE id='mailbox'");
	await expect(autoSettings()).rejects.toThrow("Disable the out-of-office");
});
test("chat streams source events, selected model/time context and persisted conversation messages", async () => {
	await configure();
	await autoSettings({ modelId: "second-model" });
	let sent: ReturnType<typeof inputBody> | undefined;
	const chat = await createAgentChatStream(
		ctx,
		"Summarize this email",
		undefined,
		undefined,
		"Europe/Rome",
		"message",
		async (_url, init) => {
			sent = inputBody(init);
			expect(new Headers(init?.headers).get("Authorization")).toBe(
				"Bearer " + privateKey,
			);
			return sse([{ role: "assistant", content: "Here is the summary." }]);
		},
	);
	const output = await events(chat.stream);
	expect(output[0]).toMatchObject({
		type: "conversation",
		conversationId: chat.conversationId,
	});
	expect(
		output
			.filter((row) => row.type === "text")
			.map((row) => row.text)
			.join(""),
	).toBe("Here is the summary.");
	expect(output.at(-1)).toEqual({ type: "done" });
	expect(sent?.model).toBe("second-model");
	expect(JSON.stringify(sent?.messages)).toContain("Europe/Rome");
	expect(JSON.stringify(sent?.messages)).toContain("email message open");
	const history = await getAgentChatHistory(ctx, chat.conversationId);
	expect(history.map((row) => row.role)).toEqual(["user", "assistant"]);
	expect(history[0]?.content).toBe("Summarize this email");
	expect(history[1]?.content).toBe("Here is the summary.");
	expect((await listAgentConversations(ctx))[0]?.id).toBe(chat.conversationId);
});
test("multi-step chat reads the selected mailbox and preserves tool/reasoning events without marking mail read", async () => {
	await configure();
	let rounds = 0;
	const chat = await createAgentChatStream(
		ctx,
		"Read this email",
		undefined,
		undefined,
		"UTC",
		"message",
		async (_url, init) => {
			const data = inputBody(init);
			rounds++;
			if (!data.messages.some((row) => row.role === "tool"))
				return sse(
					[
						{ role: "assistant", content: "I will read the email." },
						{
							tool_calls: [
								{
									index: 0,
									id: "call-read",
									type: "function",
									function: {
										name: "get_email",
										arguments: JSON.stringify({ emailId: "message" }),
									},
								},
							],
						},
					],
					"tool-calls",
				);
			return sse([
				{ role: "assistant", content: "The email welcomes you to Mailrun." },
			]);
		},
	);
	const output = await events(chat.stream);
	expect(rounds).toBe(2);
	expect(
		output.some(
			(row) =>
				row.type === "reclassify" && row.text === "I will read the email.",
		),
	).toBe(true);
	expect(
		output.find((row) => row.type === "tool" && row.state === "complete"),
	).toMatchObject({
		name: "get_email",
		result: { id: "message", read: false, text: "Welcome to Mailrun" },
		recordId: expect.any(String),
	});
	expect(
		state.db.query("SELECT read FROM messages WHERE id='message'").get(),
	).toEqual({ read: 0 });
	const history = await getAgentChatHistory(ctx, chat.conversationId);
	expect(history.some((row) => row.toolName === "__reasoning__")).toBe(true);
	expect(history.at(-1)?.content).toBe("The email welcomes you to Mailrun.");
	expect(state.db.query("SELECT count(*) AS n FROM ai_usage").get()).toEqual({
		n: 2,
	});
});
test("chat mail changes remain proposals until the owning user confirms an atomic action", async () => {
	await configure();
	const chat = await createAgentChatStream(
		ctx,
		"Mark the message read",
		undefined,
		undefined,
		"UTC",
		"message",
		async (_url, init) =>
			inputBody(init).messages.some((row) => row.role === "tool")
				? sse([{ role: "assistant", content: "Approve the change below." }])
				: sse(
						[
							{
								tool_calls: [
									{
										index: 0,
										id: "call-mark",
										type: "function",
										function: {
											name: "mark_email_read",
											arguments: JSON.stringify({
												emailId: "message",
												read: true,
											}),
										},
									},
								],
							},
						],
						"tool-calls",
					),
	);
	const output = await events(chat.stream),
		tool = output.find(
			(row) => row.type === "tool" && row.state === "complete",
		);
	expect(tool.result.status).toBe("pending_approval");
	expect(
		state.db.query("SELECT read FROM messages WHERE id='message'").get(),
	).toEqual({ read: 0 });
	await expect(confirmAgentAction(stranger, tool.recordId)).rejects.toThrow(
		"Action not found",
	);
	const changed = await confirmAgentAction(owner, tool.recordId);
	expect(changed).toMatchObject({
		status: "approved",
		result: { emailId: "message", read: true },
	});
	expect(
		state.db.query("SELECT read FROM messages WHERE id='message'").get(),
	).toEqual({ read: 1 });
	await expect(confirmAgentAction(owner, tool.recordId)).rejects.toThrow(
		"already approved",
	);
});
test("conversation IDs, current-email context and tool targets never cross authors or mailboxes", async () => {
	await configure();
	const chat = await createAgentChatStream(
		ctx,
		"Hello",
		undefined,
		undefined,
		"UTC",
		undefined,
		async () => sse([{ content: "Hi" }]),
	);
	await events(chat.stream);
	enableTeamSharing(state.db);
	state.db.exec(
		"INSERT INTO mailbox_access(id,user_id,mailbox_id,permission,created_at) VALUES('share','stranger','mailbox','read_only',1); INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,created_at) VALUES('secret','stranger','mailbox','outbound','hello@example.com','r@example.org','draft',2)",
	);
	await expect(
		getAgentChatHistory({ ...ctx, user: stranger }, chat.conversationId),
	).rejects.toThrow("Conversation not found");
	let captured = "";
	const ignored = await createAgentChatStream(
		ctx,
		"Summarize",
		undefined,
		undefined,
		"UTC",
		"secret",
		async (_url, init) => {
			captured = JSON.stringify(inputBody(init).messages);
			return sse([{ content: "Which email?" }]);
		},
	);
	await events(ignored.stream);
	expect(captured).not.toContain("email secret open");
	await expect(
		createAgentChatStream(
			{ ...ctx, user: stranger },
			"Hello",
			chat.conversationId,
			undefined,
			undefined,
			undefined,
			async () => {
				throw Error("Must not call");
			},
		),
	).rejects.toThrow("Conversation not found");
	await deleteAgentConversation(ctx, chat.conversationId);
	expect(await listAgentConversations(ctx)).not.toContainEqual(
		expect.objectContaining({ id: chat.conversationId }),
	);
});
test("model errors are visible while configured credentials stay out of streams and history", async () => {
	await configure();
	const chat = await createAgentChatStream(
		ctx,
		"Hello",
		undefined,
		undefined,
		undefined,
		undefined,
		async () =>
			Response.json(
				{ error: { message: "Incorrect API key " + privateKey } },
				{ status: 401 },
			),
	);
	const output = await events(chat.stream);
	expect(output.some((row) => row.type === "error")).toBe(true);
	expect(JSON.stringify(output)).not.toContain(privateKey);
	expect(JSON.stringify(output)).toContain("[redacted]");
	await setAgentEnabled(owner, false);
	await expect(createAgentChatStream(ctx, "No")).rejects.toThrow("disabled");
});
test("cancelling a chat aborts its provider request and retains the already-stored user turn", async () => {
	await configure();
	const started = Promise.withResolvers<void>(),
		cancelled = Promise.withResolvers<void>();
	const chat = await createAgentChatStream(
		ctx,
		"Long request",
		undefined,
		undefined,
		undefined,
		undefined,
		async (_url, init) => {
			started.resolve();
			return await new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				signal?.addEventListener(
					"abort",
					() => {
						cancelled.resolve();
						reject(new DOMException("Cancelled", "AbortError"));
					},
					{ once: true },
				);
			});
		},
	);
	await started.promise;
	await chat.stream.cancel();
	await cancelled.promise;
	expect(
		(await getAgentChatHistory(ctx, chat.conversationId))[0]?.content,
	).toBe("Long request");
});
test("chat HTTP requires a session and valid mutation origin and retains the NDJSON contract", async () => {
	await configure();
	const token = crypto.randomUUID();
	state.db
		.query(
			"INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES('agent-session','owner',?,?,?)",
		)
		.run(await hash(token), seconds() + 300, seconds());
	const make = (origin = publicOrigin(), authorization = "Bearer " + token) =>
		new Request(publicOrigin() + "/api/agent/chat", {
			method: "POST",
			headers: {
				Origin: origin,
				Authorization: authorization,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ mailboxId: "mailbox", text: "Hi" }),
		});
	expect(
		(
			await serveAgentChat(
				make("https://untrusted.example"),
				undefined,
				async () => {
					throw Error("No");
				},
			)
		).status,
	).toBe(403);
	expect(
		(
			await serveAgentChat(
				make(publicOrigin(), "Bearer ep_not-a-session"),
				undefined,
				async () => {
					throw Error("No");
				},
			)
		).status,
	).toBe(401);
	const response = await serveAgentChat(make(), undefined, async () =>
		sse([{ content: "Hello" }]),
	);
	expect(response.status).toBe(200);
	expect(response.headers.get("Content-Type")).toContain(
		"application/x-ndjson",
	);
	expect(response.headers.get("X-Conversation-Id")).toContain("conv_");
	expect(await response.text()).toContain('"type":"done"');
});
test("automatic draft eligibility filters spam, automated senders, own identities and duplicate deliveries", async () => {
	await configure();
	await autoSettings();
	for (const extra of [
		{ status: "spam" },
		{ folderId: "folder" },
		{ spamVerdict: "suspicious" },
		{ spamAnalysisError: "failed" },
		{ sender: "no-reply@example.org" },
		{ headers: { "Auto-Submitted": "auto-generated" } },
		{ sender: "hello@example.com" },
	])
		expect(await schedule(extra)).toBeNull();
	const first = await schedule();
	expect(first).toBeDefined();
	expect(await schedule()).toBe(first);
	expect(state.db.query("SELECT id FROM agent_jobs").all()).toHaveLength(1);
});
test("automatic replies generate one reviewable draft, record usage and never queue mail delivery", async () => {
	await configure();
	await autoSettings();
	const job = await schedule();
	let count = 0;
	expect(
		await processAgentDraftJob(job!, async (_url, init) => {
			count++;
			const data = inputBody(init);
			expect(data.stream).not.toBe(true);
			expect(JSON.stringify(data.messages)).toContain("Welcome to Mailrun");
			return completion();
		}),
	).toBe(true);
	const row = state.db
		.query<{ status: string; draft_id: string }, []>(
			"SELECT status,draft_id FROM agent_jobs",
		)
		.get()!;
	expect(row.status).toBe("completed");
	const draft = await getDraft(owner, row.draft_id);
	expect(draft).toMatchObject({
		to_addr: "sender@example.org",
		subject: "Re: A searchable subject",
		text_body: "Tuesday works for me.",
		status: "draft",
	});
	expect(
		state.db
			.query("SELECT origin,source_message_id FROM agent_draft_metadata")
			.get(),
	).toEqual({ origin: "auto", source_message_id: "message" });
	expect(state.db.query("SELECT id FROM outbound_jobs").all()).toEqual([]);
	expect(
		state.db
			.query(
				"SELECT source,input_tokens,output_tokens,cost_usd_micros FROM ai_usage",
			)
			.get(),
	).toEqual({
		source: "auto_draft",
		input_tokens: 8,
		output_tokens: 4,
		cost_usd_micros: 32,
	});
	await processAgentDraftJob(job!, async () => {
		throw Error("Must not repeat");
	});
	expect(count).toBe(1);
});
test("daily limits and superseding thread mail skip generation before contacting a model", async () => {
	await configure();
	await autoSettings({ dailyLimit: 1 });
	state.db.exec(
		"INSERT INTO agent_jobs(id,mailbox_id,source_message_id,reviewer_user_id,status,next_attempt_at,created_at) VALUES('done','mailbox','message','owner','completed',0," +
			seconds() +
			")",
	);
	state.db.exec(
		"INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,created_at) VALUES('second','owner','mailbox','inbound','sender@example.org','hello@example.com',2)",
	);
	const limited = await schedule({ sourceMessageId: "second" });
	await processAgentDraftJob(limited!, async () => {
		throw Error("Quota must stop model");
	});
	expect(
		state.db
			.query("SELECT status,reason FROM agent_jobs WHERE id=?")
			.get(limited),
	).toEqual({ status: "skipped", reason: "Daily draft limit reached" });
	state.db.exec(
		"DELETE FROM agent_jobs; UPDATE messages SET thread_id='thread' WHERE id IN('message','second')",
	);
	const older = await schedule();
	await processAgentDraftJob(older!, async () => {
		throw Error("Newer mail must stop model");
	});
	expect(
		state.db
			.query("SELECT status,reason FROM agent_jobs WHERE id=?")
			.get(older),
	).toMatchObject({
		status: "skipped",
		reason: "A newer message or sent reply superseded this draft",
	});
});
test("automatic job failures retain source retry dates, terminal attempts and redacted reasons", async () => {
	await configure();
	await autoSettings();
	const job = await schedule();
	for (let attempt = 1; attempt <= 3; attempt++) {
		state.db.exec("UPDATE agent_jobs SET next_attempt_at=0");
		await processAgentDraftJob(job!, async () =>
			completion("Here is the draft: no"),
		);
		expect(
			state.db
				.query("SELECT status,attempts FROM agent_jobs WHERE id=?")
				.get(job),
		).toEqual({
			status: attempt === 3 ? "failed" : "pending",
			attempts: attempt,
		});
	}
	expect(
		state.db.query("SELECT draft_id FROM agent_draft_metadata").all(),
	).toEqual([]);
	const retried = await bodyResponse(
		await agentApi(
			request("/api/agent/jobs/" + job + "/retry", "POST", {}),
			owner,
		),
	);
	expect(retried.status).toBe(200);
	expect(
		state.db
			.query("SELECT status,attempts FROM agent_jobs WHERE id=?")
			.get(job),
	).toEqual({ status: "pending", attempts: 0 });
});

test("action approvals roll back complete batches and preserve long, valid proposal records", async () => {
	const turn = await startAgentTurn(ctx, "Move these messages"),
		proposal = await runEmailTool(ctx, "move_emails", {
			emailIds: ["message"],
			destination: "trash",
		}),
		record = await saveAgentChatMessage(
			ctx,
			turn.conversationId,
			"tool",
			JSON.stringify(proposal),
			"move_emails",
		);
	const raw = state.db
		.query<{ content: string }, [string]>(
			"SELECT content FROM agent_chat_messages WHERE id=?",
		)
		.get(record)!.content;
	state.db
		.query("UPDATE agent_chat_messages SET content=? WHERE id=?")
		.run(
			JSON.stringify({ ...JSON.parse(raw), emailIds: ["message", "missing"] }),
			record,
		);
	await expect(confirmAgentAction(owner, record)).rejects.toThrow(
		"Cannot move",
	);
	expect(
		state.db.query("SELECT status FROM messages WHERE id='message'").get(),
	).toEqual({ status: "received" });
	expect(
		JSON.parse(
			state.db
				.query<{ content: string }, [string]>(
					"SELECT content FROM agent_chat_messages WHERE id=?",
				)
				.get(record)!.content,
		).status,
	).toBe("pending_approval");
	state.db
		.query("UPDATE agent_chat_messages SET content=? WHERE id=?")
		.run(raw, record);
	const outcomes = await Promise.allSettled([
		confirmAgentAction(owner, record),
		confirmAgentAction(owner, record),
	]);
	expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
		1,
	);
	expect(
		state.db.query("SELECT status FROM messages WHERE id='message'").get(),
	).toEqual({ status: "trash" });
});
test("read-only users can chat about visible mail but cannot create drafts or approve management actions", async () => {
	await configure();
	enableTeamSharing(state.db);
	state.db.exec(
		"INSERT INTO mailbox_access(id,user_id,mailbox_id,permission,created_at) VALUES('share','stranger','mailbox','read_only',1)",
	);
	const readonly = { ...ctx, user: stranger },
		turn = await startAgentTurn(readonly, "Read");
	const proposal = await runEmailTool(readonly, "mark_email_read", {
			emailId: "message",
			read: true,
		}),
		record = await saveAgentChatMessage(
			readonly,
			turn.conversationId,
			"tool",
			JSON.stringify(proposal),
			"mark_email_read",
		);
	await confirmAgentAction(stranger, record);
	expect(
		state.db.query("SELECT read FROM messages WHERE id='message'").get(),
	).toEqual({ read: 1 });
	const forged = await saveAgentChatMessage(
		readonly,
		turn.conversationId,
		"tool",
		JSON.stringify({
			action: "move_email",
			status: "pending_approval",
			emailIds: ["message"],
			destination: "trash",
		}),
		"move_email",
	);
	await expect(confirmAgentAction(stranger, forged)).rejects.toThrow("Mailbox");
	await expect(
		runEmailTool(readonly, "draft_email", {
			to: "r@example.org",
			subject: "No",
			body: "No",
		}),
	).rejects.toThrow("permission");
});
test("automatic jobs serialize a mailbox and stale worker attempts cannot publish or overwrite a newer claim", async () => {
	await configure();
	await autoSettings();
	const job = await schedule(),
		started = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let calls = 0;
	const running = processAgentDraftJob(job!, async () => {
		calls++;
		started.resolve();
		await release.promise;
		return completion("The old attempt.");
	});
	await started.promise;
	expect(
		await processAgentDraftJob(job!, async () => {
			calls++;
			return completion();
		}),
	).toBe(false);
	state.db
		.query(
			"UPDATE agent_jobs SET status='pending',attempts=2,lease_until=NULL,next_attempt_at=0 WHERE id=?",
		)
		.run(job);
	release.resolve();
	await running;
	expect(
		state.db.query("SELECT draft_id FROM agent_draft_metadata").all(),
	).toEqual([]);
	expect(
		state.db
			.query("SELECT status,attempts FROM agent_jobs WHERE id=?")
			.get(job),
	).toEqual({ status: "pending", attempts: 2 });
	await processAgentDraftJob(job!, async () => {
		calls++;
		return completion("The current attempt.");
	});
	expect(
		state.db
			.query("SELECT status,attempts FROM agent_jobs WHERE id=?")
			.get(job),
	).toEqual({ status: "completed", attempts: 3 });
	expect(
		state.db.query("SELECT draft_id FROM agent_draft_metadata").all(),
	).toHaveLength(1);
	expect(calls).toBe(2);
});
test("settings, newer mail and reviewer changes during inference prevent automatic draft publication", async () => {
	for (const change of ["disabled", "newer", "reviewer"] as const) {
		state.db.exec("DELETE FROM agent_jobs; DELETE FROM agent_draft_metadata;");
		await configure();
		await autoSettings();
		state.db.exec(
			"UPDATE messages SET thread_id='thread' WHERE id='message'; DELETE FROM messages WHERE id='newer'",
		);
		const job = await schedule();
		await processAgentDraftJob(job!, async () => {
			if (change === "disabled")
				await saveMailboxAgentSettings(owner, {
					mailboxId: "mailbox",
					enabled: true,
					autoDraftEnabled: false,
					reviewerUserId: "owner",
					instructions: "",
					dailyLimit: 25,
					modelId: "fixture-model",
				});
			if (change === "newer")
				state.db.exec(
					"INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,thread_id,created_at) VALUES('newer','owner','mailbox','inbound','sender@example.org','hello@example.com','received','thread',2)",
				);
			if (change === "reviewer")
				state.db.exec(
					"UPDATE mailbox_agent_settings SET reviewer_user_id='stranger' WHERE mailbox_id='mailbox'",
				);
			return completion();
		});
		expect(
			state.db.query("SELECT draft_id FROM agent_draft_metadata").all(),
		).toEqual([]);
		expect(
			state.db.query("SELECT status FROM agent_jobs WHERE id=?").get(job),
		).toEqual({ status: "skipped" });
	}
});
test("automatic context excludes other authors drafts and resolves alias self-send suppression", async () => {
	await configure();
	await autoSettings();
	state.db.exec(
		"UPDATE messages SET thread_id='thread' WHERE id='message'; INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,thread_id,text_body,created_at) VALUES('private','stranger','mailbox','outbound','hello@example.com','r@example.org','draft','thread','PRIVATE OTHER AUTHOR',0); INSERT INTO mailbox_aliases(id,mailbox_id,domain_id,local_part,created_at) VALUES('alias','mailbox','domain','alias',1)",
	);
	expect(await schedule({ sender: "alias@example.com" })).toBeNull();
	const job = await schedule();
	let sent = "";
	await processAgentDraftJob(job!, async (_url, init) => {
		sent = String(init?.body);
		return completion();
	});
	expect(sent).not.toContain("PRIVATE OTHER AUTHOR");
});
test("inbound mail and its eligible automatic job commit together and replay only once", async () => {
	await configure();
	await autoSettings();
	state.db.exec("UPDATE users SET spam_protection_enabled=0 WHERE id='owner'");
	const raw = new TextEncoder().encode(
		"From: sender@example.org\r\nTo: hello@example.com\r\nMessage-ID: <atomic-agent@example.org>\r\nSubject: Agent inbound\r\n\r\nPlease draft a reply.",
	);
	const first = await storeInbound(
		"sender@example.org",
		"hello@example.com",
		raw,
	);
	expect(first.action).toBe("store");
	const jobs = state.db
		.query<{ source_message_id: string }, []>(
			"SELECT source_message_id FROM agent_jobs",
		)
		.all();
	expect(jobs).toHaveLength(1);
	expect(
		state.db
			.query("SELECT id FROM messages WHERE id=?")
			.get(jobs[0]!.source_message_id),
	).toBeDefined();
	await storeInbound("sender@example.org", "hello@example.com", raw);
	expect(state.db.query("SELECT id FROM agent_jobs").all()).toHaveLength(1);
});
test("the eager dispatcher isolates request context and shares a persistent lease with recovery", async () => {
	await configure();
	await autoSettings();
	const als = new AsyncLocalStorage<string>(),
		seen: (string | undefined)[] = [],
		stop = startAgentDispatcher(async () => {
			seen.push(als.getStore());
			return completion();
		});
	try {
		const job = await schedule();
		als.run("private request body", () => wakeAgentDispatcher());
		const until = Date.now() + 2000;
		while (
			state.db
				.query<{ status: string }, [string | null] | []>(
					"SELECT status FROM agent_jobs WHERE id=?",
				)
				.get(job)?.status !== "completed" &&
			Date.now() < until
		)
			await Bun.sleep(10);
		expect(seen).toEqual([undefined]);
		expect(
			state.db.query("SELECT status FROM agent_jobs WHERE id=?").get(job),
		).toEqual({ status: "completed" });
	} finally {
		await stop();
	}
});
test("expired running jobs recover and explicit dispatcher leases prevent duplicate recovery", async () => {
	await configure();
	await autoSettings();
	const job = await schedule();
	state.db.exec(
		"UPDATE agent_jobs SET status='running',attempts=1,lease_until=0",
	);
	state.db
		.query(
			"INSERT INTO mailrun_job_leases(name,owner,expires_at) VALUES('agent-dispatch','other',?)",
		)
		.run(seconds() + 60);
	expect(
		await recoverAgentDraftJobs(async () => {
			throw Error("Must not run");
		}),
	).toBe(0);
	state.db.exec("DELETE FROM mailrun_job_leases WHERE name='agent-dispatch'");
	expect(await recoverAgentDraftJobs(async () => completion())).toBe(1);
	expect(
		state.db
			.query("SELECT status,attempts FROM agent_jobs WHERE id=?")
			.get(job),
	).toEqual({ status: "completed", attempts: 2 });
});
test("assistant configuration, conversation history and pending jobs survive existing backup/restore", async () => {
	await configure();
	await autoSettings();
	const chat = await createAgentChatStream(
		ctx,
		"Backup this turn",
		undefined,
		undefined,
		undefined,
		undefined,
		async () => sse([{ content: "It is saved." }]),
	);
	await events(chat.stream);
	await schedule();
	const file = state.directory + "/agent.json";
	await writeBackup(state.path, file);
	state.db.exec(
		"DELETE FROM agent_conversations; DELETE FROM agent_jobs; DELETE FROM mailbox_agent_settings",
	);
	restoreBackup(state.db, await Bun.file(file).json());
	expect(
		(await getAgentChatHistory(ctx, chat.conversationId)).at(-1)?.content,
	).toBe("It is saved.");
	expect((await getAgentProviderConfig()).apiKey).toBe(privateKey);
	expect(state.db.query("SELECT status FROM agent_jobs").get()).toEqual({
		status: "pending",
	});
	await recoverAgentDraftJobs(async () => completion());
	expect(state.db.query("SELECT status FROM agent_jobs").get()).toEqual({
		status: "completed",
	});
});
test("AI usage retains totals, price coverage, user timezone days and page validation", async () => {
	const now = seconds();
	for (let i = 0; i < 21; i++)
		state.db
			.query(
				"INSERT INTO ai_usage(id,provider,model,source,input_tokens,output_tokens,cost_usd_micros,created_at) VALUES(?,?,?,?,?,?,?,?)",
			)
			.run(
				"usage-" + i,
				"custom",
				"fixture-model",
				"chat",
				8,
				4,
				i === 0 ? null : 32,
				now - i,
			);
	await expect(
		aiUsageApi(request("/api/admin/ai-usage"), stranger),
	).rejects.toMatchObject({ status: 403 });
	const result = await bodyResponse(
		await aiUsageApi(
			new Request(publicOrigin() + "/api/admin/ai-usage?page=2", {
				headers: { "X-Time-Zone": "Europe/Rome" },
			}),
			owner,
		),
	);
	expect(result.status).toBe(200);
	expect(result.data).toMatchObject({
		timeZone: "Europe/Rome",
		page: 2,
		pageSize: 20,
		totalPages: 2,
		totals: {
			requests: 21,
			inputTokens: 168,
			outputTokens: 84,
			totalTokens: 252,
			costUsdMicros: 640,
			pricedRequests: 20,
		},
	});
	expect(result.data.rows).toHaveLength(1);
	expect(result.data.daily).toHaveLength(30);
	expect(
		result.data.daily.reduce(
			(sum: number, row: { requests: number }) => sum + row.requests,
			0,
		),
	).toBe(21);
	expect(
		(await aiUsageApi(request("/api/admin/ai-usage?page=0"), owner))?.status,
	).toBe(400);
});

test("bulk action proposals remain valid JSON beyond the old history truncation boundary", async () => {
	await configure();
	const ids: string[] = [];
	for (let i = 0; i < 20; i++) {
		const id = "long-" + i;
		ids.push(id);
		state.db
			.query(
				"INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,snippet,status,created_at) VALUES(?,'owner','mailbox','inbound','sender@example.org','hello@example.com',?,?,'received',?)",
			)
			.run(id, "Q".repeat(900), "A useful preview", i + 2);
	}
	const chat = await createAgentChatStream(
		ctx,
		"Archive these twenty messages",
		undefined,
		undefined,
		undefined,
		undefined,
		async (_url, init) =>
			inputBody(init).messages.some((row) => row.role === "tool")
				? sse([{ content: "Approve the archive action." }])
				: sse(
						[
							{
								tool_calls: [
									{
										index: 0,
										id: "bulk",
										type: "function",
										function: {
											name: "move_emails",
											arguments: JSON.stringify({
												emailIds: ids,
												destination: "archived",
											}),
										},
									},
								],
							},
						],
						"tool-calls",
					),
	);
	const output = await events(chat.stream),
		tool = output.find(
			(row) => row.type === "tool" && row.state === "complete",
		),
		stored = state.db
			.query<{ content: string }, [string]>(
				"SELECT content FROM agent_chat_messages WHERE id=?",
			)
			.get(tool.recordId)!;
	expect(stored.content.length).toBeGreaterThan(12000);
	expect(JSON.parse(stored.content).emailIds).toHaveLength(20);
	await confirmAgentAction(owner, tool.recordId);
	expect(
		state.db
			.query("SELECT count(*) AS n FROM messages WHERE status=?")
			.get("archived"),
	).toEqual({ n: 20 });
});
test("independent Bun processes cannot generate and publish the same automatic draft twice", async () => {
	await configure();
	await autoSettings();
	const job = await schedule(),
		script = state.directory + "/independent-agent.ts",
		gate = state.directory + "/release";
	await Bun.write(
		script,
		`
  import {processAgentDraftJob} from ${JSON.stringify(process.cwd() + "/src/server/agent/jobs.ts")};
  process.env.DATA_DIR=process.argv[2]!;delete process.env.NIBRUN_DATA_DIR;
  const worked=await processAgentDraftJob(process.argv[3]!,async()=>{
   console.log('started');while(!await Bun.file(process.argv[4]!).exists())await Bun.sleep(10);
   return Response.json({id:'fixture',object:'chat.completion',created:1,model:'fixture-model',choices:[{index:0,message:{role:'assistant',content:'One independent draft.'},finish_reason:'stop'}],usage:{prompt_tokens:8,completion_tokens:4,total_tokens:12}});
  });console.log(JSON.stringify({worked}));
 `,
	);
	const options = {
			cwd: state.directory,
			env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
			stdout: "pipe" as const,
			stderr: "pipe" as const,
		},
		first = Bun.spawn(
			[process.execPath, script, state.directory, job!, gate],
			options,
		),
		errors = new Response(first.stderr).text();
	try {
		const reader = first.stdout.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toContain(
			"started",
		);
		reader.releaseLock();
		const second = Bun.spawn(
			[process.execPath, script, state.directory, job!, gate],
			options,
		);
		const secondOutput = await new Response(second.stdout).text();
		expect(await second.exited).toBe(0);
		expect(secondOutput).toContain('"worked":false');
		await Bun.write(gate, "go");
		expect(await first.exited).toBe(0);
		expect(
			state.db.query("SELECT draft_id FROM agent_draft_metadata").all(),
		).toHaveLength(1);
		expect(
			state.db.query("SELECT status,attempts FROM agent_jobs").get(),
		).toEqual({ status: "completed", attempts: 1 });
	} finally {
		first.kill();
		await first.exited;
		await errors;
	}
});

test("legacy folded reply headers span input chunks while MIME bodies stay outside header parsing", async () => {
	for (const newline of ["\r\n", "\n", "\r"]) {
		const raw = [
			"From: sender@example.org",
			"X-Large: " + "x".repeat(70000),
			"Reply-To: Preferred",
			" <preferred@example.org>",
			"To: hello@example.com",
			"Subject: Header only",
			"",
			"Body content that must not become headers.",
		].join(newline);
		const whole = await PostalMime.parse(raw),
			headers = await readMailHeaderBlock(new Blob([raw]));
		expect((await PostalMime.parse(headers)).replyTo).toEqual(whole.replyTo);
		expect(new TextDecoder().decode(headers)).not.toContain("Body content");
	}
});

test("a worker returning after its lease expires releases the job for recovery instead of skipping it permanently", async () => {
	await configure();
	await autoSettings();
	const job = await schedule(),
		clock = Date.now();
	try {
		await processAgentDraftJob(job!, async () => {
			setSystemTime(new Date(clock + 601000));
			return completion();
		});
		expect(
			state.db
				.query("SELECT status,attempts,draft_id FROM agent_jobs WHERE id=?")
				.get(job),
		).toEqual({ status: "pending", attempts: 1, draft_id: null });
		expect(
			state.db.query("SELECT draft_id FROM agent_draft_metadata").all(),
		).toEqual([]);
	} finally {
		setSystemTime();
	}
	state.db.exec("UPDATE agent_jobs SET next_attempt_at=0");
	await recoverAgentDraftJobs(async () => completion("Recovered draft."));
	expect(
		state.db
			.query("SELECT status,attempts FROM agent_jobs WHERE id=?")
			.get(job),
	).toEqual({ status: "completed", attempts: 2 });
});

test("graceful interruption returns automatic work to pending without consuming its retry budget", async () => {
	await configure();
	await autoSettings();
	const job = await schedule(),
		abort = new AbortController(),
		started = Promise.withResolvers<void>();
	const running = processAgentDraftJob(
		job!,
		async (_url, init) => {
			started.resolve();
			return await new Promise<Response>((_resolve, reject) =>
				init?.signal?.addEventListener(
					"abort",
					() => reject(new DOMException("Server restarting", "AbortError")),
					{ once: true },
				),
			);
		},
		abort.signal,
	);
	await started.promise;
	abort.abort();
	await running;
	expect(
		state.db
			.query("SELECT status,attempts,lease_until FROM agent_jobs WHERE id=?")
			.get(job),
	).toEqual({ status: "pending", attempts: 0, lease_until: null });
	await recoverAgentDraftJobs(async () => completion());
	expect(
		state.db
			.query("SELECT status,attempts FROM agent_jobs WHERE id=?")
			.get(job),
	).toEqual({ status: "completed", attempts: 1 });
});
