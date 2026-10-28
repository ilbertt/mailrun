import { z } from "zod";
export type AgentFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;
import { agentProviderErrorMessage } from "./errors";
import { withDatabase, seconds, id } from "../db";
import type { User } from "../../shared/contracts";
import type {
	AgentProviderConfig,
	AgentProviderPreset,
	AgentModelOption,
} from "../../lib/agent/provider-types";
import {
	AGENT_SETTINGS_ID,
	DEFAULT_CLOUDFLARE_MODEL,
	PROVIDER_BASE_URLS,
} from "../../lib/agent/provider-constants";
import { parseAgentModelIds } from "../../lib/agent/model-ids";
import { parseAgentModelRates, calculateAgentCostUsdMicros } from "./pricing";
import { adminWrite } from "../admin/accounts";
import type { LanguageModelUsage } from "ai";
export function resolveAgentBaseUrl(
	preset: AgentProviderPreset,
	value: string,
) {
	if (preset !== "custom") return PROVIDER_BASE_URLS[preset];
	const url = new URL(value.trim());
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error(
			"Custom provider URL must be an HTTPS base URL without credentials or query parameters",
		);
	return url.toString().replace(/\/$/, "");
}
export async function getAgentEnabled() {
	const [row] = await withDatabase(
		(sql) =>
			sql.NativeAssistantEnabled`SELECT agent_enabled FROM app_settings WHERE id=${AGENT_SETTINGS_ID}`,
	);
	return row ? !!row.agent_enabled : true;
}
export async function getAgentProviderConfig(): Promise<AgentProviderConfig> {
	const [saved] = await withDatabase(
			(sql) =>
				sql.NativeAgentProviderConfig`SELECT agent_provider,agent_preset,agent_base_url,agent_api_key,agent_model,agent_model_rates FROM app_settings WHERE id=${AGENT_SETTINGS_ID}`,
		),
		rates = parseAgentModelRates(saved?.agent_model_rates ?? null);
	if (saved?.agent_provider === "cloudflare") {
		const models = parseAgentModelIds(
			saved.agent_model || process.env.AI_MODEL || DEFAULT_CLOUDFLARE_MODEL,
		);
		return {
			provider: "cloudflare",
			preset: "openai",
			baseUrl: "",
			apiKey: "",
			model: models[0] || DEFAULT_CLOUDFLARE_MODEL,
			models,
			rates,
			source: "saved",
		};
	}
	if (saved?.agent_provider === "compatible") {
		const preset = z
				.enum(["openai", "openrouter", "groq", "custom"])
				.catch("custom")
				.parse(saved.agent_preset),
			baseUrl = resolveAgentBaseUrl(preset, saved.agent_base_url || ""),
			models = parseAgentModelIds(saved.agent_model || "");
		return {
			provider: "compatible",
			preset,
			baseUrl,
			apiKey:
				saved.agent_api_key ||
				(process.env.AI_BASE_URL === baseUrl ? process.env.AI_API_KEY : "") ||
				"",
			model: models[0] || "",
			models,
			rates,
			source: "saved",
		};
	}
	if (process.env.AI_BASE_URL && process.env.AI_API_KEY) {
		const model = process.env.AI_MODEL || "gpt-4o-mini";
		return {
			provider: "compatible",
			preset: "custom",
			baseUrl: process.env.AI_BASE_URL,
			apiKey: process.env.AI_API_KEY,
			model,
			models: [model],
			rates,
			source: "environment",
		};
	}
	return {
		provider: "cloudflare",
		preset: "openai",
		baseUrl: "",
		apiKey: "",
		model: DEFAULT_CLOUDFLARE_MODEL,
		models: [DEFAULT_CLOUDFLARE_MODEL],
		rates,
		source: "default",
	};
}
export async function getAgentProviderPublicConfig() {
	const { apiKey, ...config } = await getAgentProviderConfig();
	return {
		...config,
		hasApiKey: !!apiKey,
		configured:
			config.provider === "compatible" &&
			!!apiKey &&
			!!config.baseUrl &&
			config.models.length > 0,
	};
}
export async function primaryAgentAdmin(
	sql: import("../db").AppSQL,
	user: User,
) {
	const [actor] =
		await sql.NativeAgentPrimaryAdmin`SELECT id FROM users WHERE id=${user.id} AND disabled=0 AND role='admin' AND is_primary_admin=1`;
	if (!actor) throw new Response("Forbidden", { status: 403 });
}
export const agentProviderSchema = z.object({
	provider: z.enum(["cloudflare", "compatible"]),
	preset: z.enum(["openai", "openrouter", "groq", "custom"]),
	baseUrl: z.string().max(500),
	apiKey: z.string().max(2000).optional(),
	model: z.string().trim().min(1).max(5000),
	rates: z
		.record(
			z.string(),
			z.object({
				input: z.number().min(0).max(1000000).nullable(),
				output: z.number().min(0).max(1000000).nullable(),
			}),
		)
		.optional(),
});
export async function saveAgentProvider(
	user: User,
	input: z.infer<typeof agentProviderSchema>,
) {
	const models = parseAgentModelIds(input.model);
	if (
		!models.length ||
		models.length > 20 ||
		models.some((value) => value.length > 200)
	)
		throw new Error("Choose 1 to 20 valid model IDs");
	// Match self-hosted Mailflare: no Workers AI binding. Cloudflare is email-only.
	if (input.provider === "cloudflare")
		throw new Error("Cloudflare Workers AI binding is unavailable");
	let base: string;
	try {
		base = resolveAgentBaseUrl(input.preset, input.baseUrl);
	} catch {
		throw new Error("Enter a valid HTTPS provider base URL");
	}
	const current = await getAgentProviderConfig(),
		key =
			input.apiKey?.trim() ||
			(current.provider === "compatible" &&
			current.preset === input.preset &&
			current.baseUrl === base
				? current.apiKey
				: "") ||
			null;
	if (!key) throw new Error("Enter an API key for this provider");
	await adminWrite(async (sql) => {
		await primaryAgentAdmin(sql, user);
		await sql.NativeSaveAgentProvider`INSERT INTO app_settings(id,agent_provider,agent_preset,agent_base_url,agent_api_key,agent_model,agent_model_rates,updated_at) VALUES(${AGENT_SETTINGS_ID},'compatible',${input.preset},${base},${key},${models.join(", ")},${JSON.stringify(Object.fromEntries(models.map((model) => [model, input.rates?.[model] ?? { input: null, output: null }])))},${seconds()}) ON CONFLICT(id) DO UPDATE SET agent_provider=excluded.agent_provider,agent_preset=excluded.agent_preset,agent_base_url=excluded.agent_base_url,agent_api_key=excluded.agent_api_key,agent_model=excluded.agent_model,agent_model_rates=excluded.agent_model_rates,updated_at=excluded.updated_at`;
	});
}
export async function setAgentEnabled(user: User, enabled: boolean) {
	await adminWrite(async (sql) => {
		await primaryAgentAdmin(sql, user);
		await sql.NativeSetAgentEnabled`INSERT INTO app_settings(id,agent_enabled,updated_at) VALUES(${AGENT_SETTINGS_ID},${enabled ? 1 : 0},${seconds()}) ON CONFLICT(id) DO UPDATE SET agent_enabled=excluded.agent_enabled,updated_at=excluded.updated_at`;
		if (!enabled) {
			await sql.NativeDisableAgentJobs`UPDATE agent_jobs SET status='skipped',reason='Assistant disabled' WHERE status='pending'`;
			await sql.NativeDisableAgentApprovals`UPDATE agent_send_approvals SET status='cancelled' WHERE status='pending'`;
		}
	});
}
export async function getAgentModel(
	requested?: string | null,
	request: AgentFetch = fetch,
) {
	const config = await getAgentProviderConfig(),
		modelId =
			requested && config.models.includes(requested) ? requested : config.model;
	if (
		config.provider !== "compatible" ||
		!config.baseUrl ||
		!config.apiKey ||
		!modelId
	)
		return null;
	const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
	const provider = createOpenAICompatible({
		name: "mailflare",
		baseURL: config.baseUrl,
		apiKey: config.apiKey,
		fetch: Object.assign(
			(url: RequestInfo | URL, options?: RequestInit) =>
				request(url, { ...options, redirect: "manual" }),
			{ preconnect: () => {} },
		),
	});
	return {
		model: provider.chatModel(modelId),
		modelId,
		provider: config.preset,
		rates: config.rates[modelId],
		errorMessage: (error: unknown) =>
			agentProviderErrorMessage(error, [config.apiKey]),
	};
}
export async function recordAiUsage(
	details: {
		modelId: string;
		provider: string;
		rates: import("../../lib/agent/provider-types").AgentModelRates | undefined;
	},
	usage: LanguageModelUsage,
	source: string,
) {
	try {
		await withDatabase(
			(sql) =>
				sql.NativeRecordAgentUsage`INSERT INTO ai_usage(id,provider,model,source,input_tokens,output_tokens,cost_usd_micros,created_at) VALUES(${id("usage")},${details.provider},${details.modelId},${source},${usage.inputTokens ?? null},${usage.outputTokens ?? null},${calculateAgentCostUsdMicros(usage, details.rates)},${seconds()})`,
		);
	} catch (error) {
		console.error("Could not record AI usage", error);
	}
}
export const CLOUDFLARE_TOOL_MODELS: AgentModelOption[] = [
	{ id: "@cf/moonshotai/kimi-k2.5", name: "Kimi K2.5" },
	{ id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", name: "Llama 3.3 70B" },
	{ id: "@cf/qwen/qwen3-30b-a3b-fp8", name: "Qwen3 30B" },
];
export async function listCompatibleAgentModels(
	input: { preset: AgentProviderPreset; baseUrl: string; apiKey?: string },
	request: AgentFetch = fetch,
) {
	const base = resolveAgentBaseUrl(input.preset, input.baseUrl),
		saved = await getAgentProviderConfig(),
		key =
			input.apiKey?.trim() ||
			(saved.provider === "compatible" &&
			saved.preset === input.preset &&
			saved.baseUrl === base
				? saved.apiKey
				: "");
	if (!key) throw new Error("Enter an API key to load models");
	const response = await request(`${base}/models`, {
		headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
		signal: AbortSignal.timeout(10000),
		redirect: "manual",
	});
	if (!response.ok)
		throw new Error(`Model list request failed (${response.status})`);
	const json = z
		.object({
			data: z
				.array(
					z.object({
						id: z.unknown().optional(),
						name: z.unknown().optional(),
						pricing: z.unknown().optional(),
					}),
				)
				.optional(),
		})
		.parse(await response.json());
	const price = (value: unknown) => {
		const number = typeof value === "string" ? Number(value) : value;
		return typeof number === "number" && Number.isFinite(number) && number >= 0
			? Number((number * 1000000).toPrecision(10))
			: null;
	};
	const models: AgentModelOption[] = (json.data ?? [])
		.flatMap((item) => {
			if (typeof item.id !== "string" || item.id.length > 200) return [];
			const pricing = z
					.object({
						prompt: z.unknown().optional(),
						completion: z.unknown().optional(),
					})
					.safeParse(item.pricing),
				priceIn = pricing.success ? price(pricing.data.prompt) : null,
				output = pricing.success ? price(pricing.data.completion) : null;
			return [
				{
					id: item.id,
					name: typeof item.name === "string" ? item.name : item.id,
					...(input.preset === "openrouter" &&
					priceIn !== null &&
					output !== null
						? { rates: { input: priceIn, output } }
						: {}),
				},
			];
		})
		.slice(0, 2000)
		.sort((a, b) => a.name.localeCompare(b.name));
	if (!models.length) throw new Error("Provider returned no models");
	return { models, source: "catalog" as const };
}
