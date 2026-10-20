import { z } from "zod";

const envelope = z.object({
	success: z.boolean(), result: z.unknown(),
	errors: z.array(z.object({ message: z.string(), code: z.number().optional() })).optional(),
});
export type CloudflareFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export async function cloudflare<T>(token: string, path: string, schema: z.ZodType<T>, init: RequestInit = {}, request: CloudflareFetch = fetch): Promise<T> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${token}`);
	if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
	const response = await request(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) });
	const body = envelope.parse(await response.json());
	if (!response.ok || !body.success) throw new Error(body.errors?.map(error => error.message).join("; ") || `Cloudflare request failed (${response.status})`);
	return schema.parse(body.result);
}
