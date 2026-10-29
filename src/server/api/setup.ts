import { RelayDeploymentError } from "../cloudflare/setup";
import { z } from "zod";
import { publicOrigin } from "../config";
import { publicAuthGuard } from "../auth/public-guard";
import { readLimitedBody } from "../http/body";
import { MxConflictError } from "../domains/cloudflare";
import { CloudflareApiError, type CloudflareFetch } from "../cloudflare/client";
import {
	setupChecks,
	setupSnapshot,
	setupDomainPreflight,
	registerWorkspace,
	requireSetupToken,
} from "../setup/service";
import { apiErrorResponse } from "./errors";

export const isSetupPath = (path: string) =>
	[
		"/api/setup/status",
		"/api/setup/prepare",
		"/api/setup/domain",
		"/api/setup/domain/mx",
		"/api/auth/register",
	].includes(path);
async function dispatchSetupApi(
	request: Request,
	onAuthorized?: () => void,
	send: CloudflareFetch = fetch,
): Promise<Response | null> {
	try {
		const path = new URL(request.url).pathname;
		if (!isSetupPath(path)) return null;
		if (
			request.method !== "GET" &&
			request.headers.get("origin") !== publicOrigin()
		)
			throw new Response("Invalid origin", { status: 403 });
		if (path === "/api/setup/status")
			return Response.json(await setupSnapshot(), {
				headers: { "Cache-Control": "no-store" },
			});
		const status = await setupSnapshot();
		if (status.hasAdminAccount)
			throw new Response("Initial setup is already complete", { status: 403 });
		if (path === "/api/setup/prepare") {
			await publicAuthGuard(request);
			const checks = await setupChecks();
			return Response.json(
				{ checks, migrated: false },
				{ status: checks.every((check) => check.configured) ? 200 : 503 },
			);
		}
		// Leave the former owner-claim API available to older installations/clients.
		const body: unknown = JSON.parse(
			new TextDecoder().decode(
				await readLimitedBody(request.clone(), 16 * 1024),
			),
		);
		if (
			path === "/api/auth/register" &&
			!(typeof body === "object" && body !== null && "domain" in body)
		)
			return null;
		const input = z
			.object({
				setupToken: z.unknown().optional(),
				turnstileToken: z.unknown().optional(),
			})
			.parse(body);
		const setupToken =
			request.headers.get("X-Mailrun-Setup-Token") ?? input.setupToken;
		requireSetupToken(setupToken);
		await publicAuthGuard(
			request,
			input.turnstileToken,
			path === "/api/auth/register",
			send,
		);
		onAuthorized?.();
		if (path === "/api/auth/register") {
			const result = await registerWorkspace(
				{ ...z.record(z.string(), z.unknown()).parse(body), setupToken },
				send,
			);
			return Response.json(result, {
				headers: {
					"Set-Cookie": `ep_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${publicOrigin().startsWith("https:") ? "; Secure" : ""}`,
				},
			});
		}
		const { hostname } = z
			.object({ hostname: z.string().min(3).max(253) })
			.parse(body);
		if (path === "/api/setup/domain" && status.hasPrimaryDomain)
			throw new Response("Primary domain already exists", { status: 409 });
		const { domain, api } = await setupDomainPreflight(hostname, send);
		return Response.json(
			path.endsWith("/mx")
				? {
						hasExistingMx:
							(await api.foreignMx(domain.zone.id, domain.hostname)).length > 0,
					}
				: { domain },
		);
	} catch (error) {
		if (
			error instanceof MxConflictError ||
			(error instanceof CloudflareApiError &&
				error.errors.some((row) => row.code === 2008))
		)
			return Response.json(
				{ error: error.message, code: "MX_RECORDS_CONFLICT" },
				{ status: 409 },
			);
		if (
			error instanceof CloudflareApiError ||
			error instanceof RelayDeploymentError
		) {
			console.warn(
				"Email setup provider check failed",
				error instanceof CloudflareApiError
					? {
							kind: "cloudflare",
							status: error.status,
							codes: error.errors.map((row) => row.code),
						}
					: { kind: "relay", message: error.message },
			);
			return Response.json({ error: error.message }, { status: 502 });
		}
		return apiErrorResponse(error);
	}
}

export async function setupApi(
	request: Request,
	onAuthorized?: () => void,
	send: CloudflareFetch = fetch,
) {
	const response = await dispatchSetupApi(request, onAuthorized, send);
	if (!response) return null;
	const headers = new Headers(response.headers);
	headers.set("Cache-Control", "no-store");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
