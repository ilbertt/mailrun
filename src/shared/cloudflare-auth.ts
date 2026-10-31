import { z } from "zod";

export const cloudflareAuthSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("token"),
		token: z.string().trim().min(1).max(500),
	}),
	z.object({
		kind: z.literal("global-key"),
		email: z.string().trim().min(1).max(500),
		key: z.string().trim().min(1).max(500),
	}),
]);
export type CloudflareAuth = z.infer<typeof cloudflareAuthSchema>;

/** Select one scheme; never carry caller-supplied credentials from the other. */
export function cloudflareAuthHeaders(
	auth: CloudflareAuth,
	init?: HeadersInit,
) {
	const headers = new Headers(init);
	headers.delete("Authorization");
	headers.delete("X-Auth-Key");
	headers.delete("X-Auth-Email");
	if (auth.kind === "global-key") {
		headers.set("X-Auth-Key", auth.key);
		headers.set("X-Auth-Email", auth.email);
	} else headers.set("Authorization", `Bearer ${auth.token}`);
	return headers;
}
