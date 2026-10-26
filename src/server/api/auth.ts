import { z } from "zod";
import { getCookie } from "@tanstack/react-start/server";
import * as auth from "../auth/service";
import { loginSchema, registerSchema } from "../../shared/contracts";
import {
	browserAccounts,
	logoutBrowserAccount,
	switchBrowserAccount,
	rememberBrowserLogin,
	issueLoginChallenge,
	verifyLoginChallenge,
} from "../auth/browser-accounts";
import { readLimitedBody } from "../mail/inbound";
export async function authApi(request: Request): Promise<Response | null> {
	const path = new URL(request.url).pathname,
		method = request.method;
	if (path === "/api/auth/accounts" && method === "GET")
		return Response.json({ accounts: await browserAccounts() });
	if (path === "/api/auth/logout" && method === "POST")
		return Response.json(await logoutBrowserAccount());
	if (path === "/api/auth/switch" && method === "POST") {
		const data = z
			.object({ userId: z.string().min(1).max(200) })
			.parse(await request.json());
		return Response.json(await switchBrowserAccount(data.userId));
	}
	if (
		!["/api/auth/login", "/api/auth/mfa/verify", "/api/auth/register"].includes(
			path,
		) ||
		method !== "POST"
	)
		return null;
	const body: unknown = JSON.parse(
		new TextDecoder().decode(await readLimitedBody(request, 16 * 1024)),
	);
	if (path === "/api/auth/login") {
		const data = loginSchema.parse(body);
		let result: Awaited<ReturnType<typeof auth.login>>;
		try {
			result = await auth.login(data);
		} catch (error) {
			throw new Response(
				error instanceof Error ? error.message : "Invalid credentials",
				{
					status:
						error instanceof Error && error.message.startsWith("Too many")
							? 429
							: 401,
				},
			);
		}
		if (result.mfaRequired)
			return Response.json({
				ok: true,
				mfaRequired: true,
				challengeToken: await issueLoginChallenge(data.email),
			});
		await rememberBrowserLogin(result.token);
		return Response.json({ ok: true, token: result.token, redirect: "/inbox" });
	}
	if (path === "/api/auth/mfa/verify") {
		const data = z
			.object({
				challengeToken: z.string().min(1).max(256),
				code: z.string().min(1).max(64),
			})
			.parse(body);
		const result = await verifyLoginChallenge(data.challengeToken, data.code);
		await rememberBrowserLogin(result.token);
		return Response.json({ ok: true, ...result, redirect: "/inbox" });
	}
	const result = await auth.register(registerSchema.parse(body));
	await rememberBrowserLogin(result.token);
	return Response.json({
		ok: true,
		token: result.token,
		redirect: "/onboarding",
	});
}
