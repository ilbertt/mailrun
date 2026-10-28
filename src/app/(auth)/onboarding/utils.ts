import { z } from "zod";
import { authFetch } from "@/lib/auth/client";
const failure = { error: z.string().optional() };
const domainResult = z.object({
	...failure,
	domain: z.object({ id: z.string() }).optional(),
	code: z.literal("MX_RECORDS_CONFLICT").optional(),
});
const domainPreflight = z.object({
	...failure,
	domain: z
		.object({
			hostname: z.string(),
			zone: z.object({ id: z.string(), name: z.string() }),
		})
		.optional(),
});
const mailboxResult = z.object({ ...failure });
async function post<T extends z.ZodType>(
	path: string,
	schema: T,
	body: unknown,
): Promise<{ ok: boolean; data: z.infer<T> }> {
	try {
		const response = await authFetch(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		return { ok: response.ok, data: schema.parse(await response.json()) };
	} catch {
		return {
			ok: false,
			data: schema.parse({ error: "Could not connect. Please try again." }),
		};
	}
}
export async function getDomains() {
	const response = await authFetch("/api/domains");
	return z
		.object({
			domains: z
				.array(z.object({ id: z.string(), hostname: z.string() }))
				.optional(),
		})
		.parse(await response.json());
}
export async function checkDomain(hostname: string) {
	const result = await post("/api/domains/check", domainPreflight, {
		hostname,
	});
	return { ok: result.ok, ...result.data };
}
export const createDomain = (
	hostname: string,
	enableSending: boolean,
	replaceMxRecords = false,
) =>
	post("/api/domains", domainResult, {
		hostname,
		enableSending,
		enableRouting: true,
		replaceMxRecords,
	});
export const createMailbox = (domainId: string, localPart: string) =>
	post("/api/mailboxes", mailboxResult, {
		domainId,
		localPart,
		displayName: localPart,
	});
