import { z } from "zod";
import { readLimitedBody } from "../mail/inbound";
import {
	passwordResetRequestSchema,
	passwordResetConfirmSchema,
} from "../../lib/validators";
import {
	requestPasswordReset,
	completePasswordReset,
} from "../auth/password-reset";
import { publicAuthGuard } from "../auth/public-guard";
import { publicOrigin } from "../config";
export async function passwordResetApi(
	request: Request,
): Promise<Response | null> {
	const path = new URL(request.url).pathname;
	if (
		request.method !== "POST" ||
		![
			"/api/auth/password-reset/request",
			"/api/auth/password-reset/confirm",
		].includes(path)
	)
		return null;
	const body: unknown = JSON.parse(
		new TextDecoder().decode(await readLimitedBody(request, 16 * 1024)),
	);
	if (path.endsWith("/request")) {
		const input = passwordResetRequestSchema.parse(body);
		await publicAuthGuard(
			request,
			z.object({ turnstileToken: z.unknown().optional() }).parse(body)
				.turnstileToken,
			true,
		);
		try {
			await requestPasswordReset(input.email, publicOrigin());
		} catch {
			console.warn("Password reset delivery failed");
		}
		return Response.json(
			{ ok: true },
			{ headers: { "Cache-Control": "no-store" } },
		);
	}
	const input = passwordResetConfirmSchema.parse(body);
	await publicAuthGuard(request);
	const result = await completePasswordReset(
		input.token,
		input.password,
		request,
	);
	return Response.json(result.ok ? { ok: true } : { error: result.error }, {
		status: result.ok ? 200 : 400,
		headers: { "Cache-Control": "no-store" },
	});
}
