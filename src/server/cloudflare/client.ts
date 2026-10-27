import { z } from "zod";

const envelope = z.object({
	success: z.boolean(),
	result: z.unknown().optional(),
	errors: z
		.array(z.object({ message: z.string(), code: z.number().optional() }))
		.optional(),
});
export class CloudflareApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly path: string,
		readonly errors: { message: string; code?: number }[],
	) {
		super(message);
		this.name = "CloudflareApiError";
	}
}
export type CloudflareFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;
export async function cloudflare<T>(
	token: string,
	path: string,
	schema: z.ZodType<T>,
	init: RequestInit = {},
	request: CloudflareFetch = fetch,
): Promise<T> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${token}`);
	if (init.body && !(init.body instanceof FormData))
		headers.set("Content-Type", "application/json");
	const response = await request(
		`https://api.cloudflare.com/client/v4${path}`,
		{ ...init, headers, signal: AbortSignal.timeout(30_000) },
	);
	let value: unknown;
	try {
		value = await response.json();
	} catch {
		throw new CloudflareApiError(
			"Cloudflare returned an invalid response",
			response.ok ? 502 : response.status,
			path,
			[],
		);
	}
	const parsed = envelope.safeParse(value);
	if (!parsed.success)
		throw new CloudflareApiError(
			"Cloudflare returned an invalid response",
			response.ok ? 502 : response.status,
			path,
			[],
		);
	const body = parsed.data;
	if (!response.ok || !body.success)
		throw new CloudflareApiError(
			body.errors?.map((error) => error.message).join("; ") ||
				`Cloudflare request failed (${response.status})`,
			response.ok ? 502 : response.status,
			path,
			body.errors ?? [],
		);
	const result = schema.safeParse(body.result);
	if (!result.success)
		throw new CloudflareApiError(
			"Cloudflare returned unexpected data",
			502,
			path,
			[],
		);
	return result.data;
}
