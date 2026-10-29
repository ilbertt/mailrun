import { z } from "zod";
import { clearClientSessionToken } from "@/lib/auth/client";
const failure = { error: z.string().optional() };
const preflight = z.object({
	hostname: z.string(),
	zone: z.object({ id: z.string(), name: z.string() }),
});
const domainResult = z.object({ ...failure, domain: preflight.optional() });
const mxResult = z.object({
	...failure,
	hasExistingMx: z.boolean().optional(),
});
const registrationResult = z.object({
	...failure,
	redirect: z.string().optional(),
	code: z.literal("MX_RECORDS_CONFLICT").optional(),
});
const preparation = z.object({
	...failure,
	migrated: z.boolean().optional(),
	checks: z
		.array(
			z.object({
				key: z.string(),
				configured: z.boolean(),
				message: z.string(),
			}),
		)
		.optional(),
});
const status = z.object({
	...failure,
	hasAdminAccount: z.boolean(),
	hasPrimaryDomain: z.boolean(),
	primaryDomain: z
		.object({ hostname: z.string(), sendingRequested: z.boolean() })
		.nullable()
		.optional(),
});
async function post<T extends z.ZodType>(
	path: string,
	schema: T,
	body?: unknown,
	setupToken?: string,
): Promise<{ ok: boolean; data: z.infer<T> }> {
	try {
		const response = await fetch(path, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(setupToken ? { "X-Mailrun-Setup-Token": setupToken } : {}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const payload: unknown = await response.json().catch(() => null);
		const parsed = schema.safeParse(payload);
		if (parsed.success) return { ok: response.ok, data: parsed.data };
		const failure = z.object({ error: z.string().min(1) }).safeParse(payload);
		return {
			ok: false,
			data: schema.parse({
				error: failure.success
					? failure.data.error
					: response.ok
						? "Setup returned an unexpected response. Please try again."
						: `Setup request failed (HTTP ${response.status}). Please try again.`,
			}),
		};
	} catch {
		return {
			ok: false,
			data: schema.parse({ error: "Could not connect. Please try again." }),
		};
	}
}
export const prepareSetup = () => post("/api/setup/prepare", preparation);
export async function getSetupStatus() {
	const response = await fetch("/api/setup/status", { cache: "no-store" }),
		data = status.parse(await response.json());
	if (!response.ok)
		throw new Error(data.error ?? "Could not load setup status");
	return data;
}
export const submitPrimaryDomain = (hostname: string, setupToken: string) =>
	post("/api/setup/domain", domainResult, { hostname }, setupToken);
export const checkExistingMx = (hostname: string, setupToken: string) =>
	post("/api/setup/domain/mx", mxResult, { hostname }, setupToken);
export async function submitRegistration(
	form: FormData,
	payload: {
		firstRun: boolean;
		domain: string;
		setupToken: string;
		enableSending?: boolean;
		replaceMxRecords?: boolean;
	},
) {
	const result = await post(
		"/api/auth/register",
		registrationResult,
		{
			domain: payload.domain,
			username: form.get("username"),
			password: form.get("password"),
			resetEmail: form.get("resetEmail"),
			turnstileToken: form.get("turnstileToken"),
			setupToken: payload.setupToken,
			enableSending: payload.enableSending,
			replaceMxRecords: payload.replaceMxRecords,
		},
		payload.setupToken,
	);
	if (result.ok) clearClientSessionToken();
	return result;
}
