import { z } from "zod";
import type { User } from "../../shared/contracts";
import type { CloudflareFetch } from "../cloudflare/client";
import { withDatabase } from "../db";
import { publicOrigin } from "../config";
import { ResendClient } from "../resend/client";
import {
	resendKeyStatus,
	saveResendKey,
	assertResendKeyAdmin,
} from "../resend/settings";
export async function resendKeyApi(
	request: Request,
	user: User,
	send: CloudflareFetch = fetch,
): Promise<Response | null> {
	if (new URL(request.url).pathname !== "/api/admin/resend-key") return null;
	await withDatabase((sql) => assertResendKeyAdmin(sql, user));
	const json = (data: unknown, status = 200) =>
		Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
	const view = ({
		configured,
		source,
	}: Awaited<ReturnType<typeof resendKeyStatus>>) => ({ configured, source });
	if (request.method === "GET") return json(view(await resendKeyStatus()));
	if (
		["PUT", "DELETE"].includes(request.method) &&
		!request.headers.get("Authorization")?.startsWith("Bearer ") &&
		request.headers.get("Sec-Fetch-Site") !== "same-origin" &&
		request.headers.get("Origin") !== publicOrigin()
	)
		return json({ error: "Invalid origin" }, 403);
	if (request.method === "DELETE")
		return json(view(await saveResendKey(user, null)));
	if (request.method === "PUT") {
		const input = z
			.object({ apiKey: z.string().trim().min(1).max(500) })
			.safeParse(await request.json().catch(() => null));
		if (!input.success) return json({ error: "Enter a Resend API key" }, 400);
		let check: { valid: boolean; canManageDomains: boolean };
		try {
			check = await new ResendClient(input.data.apiKey, send).checkKey();
		} catch (error) {
			return json({ error: "Could not reach Resend to check the key" }, 502);
		}
		if (!check.valid)
			return json({ error: "Resend rejected this API key" }, 400);
		return json({
			...view(await saveResendKey(user, input.data.apiKey)),
			canManageDomains: check.canManageDomains,
		});
	}
	return new Response(null, { status: 405 });
}
