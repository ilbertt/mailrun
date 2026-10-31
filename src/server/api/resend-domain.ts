import { z } from "zod";
import type { User } from "../../shared/contracts";
import type { CloudflareFetch } from "../cloudflare/client";
import type { DomainCloudflare } from "../domains/cloudflare";
import { MxConflictError } from "../domains/cloudflare";
import { ownedDomain, domainOperation } from "../domains/repository";
import { withDatabase } from "../db";
import { publicOrigin } from "../config";
import { ResendClient, ResendRestrictedKeyError } from "../resend/client";
import { requireResendKey, resendKeyStatus } from "../resend/settings";
import {
	getResendSending,
	setupResendSending,
	verifyResendSending,
	getResendReceiving,
	setupResendReceiving,
	removeResendSending,
	removeResendReceiving,
} from "../resend/domains";
import { sendSystemMail } from "../mail/system";
export async function resendDomainApi(
	request: Request,
	user: User,
	api?: DomainCloudflare,
	send: CloudflareFetch = fetch,
): Promise<Response | null> {
	const url = new URL(request.url),
		match =
			/^\/api\/domains\/([^/]+)\/(resend|receiving\/resend|sending|receiving)$/.exec(
				url.pathname,
			);
	if (!match) return null;
	const operation = match[2],
		method = request.method;
	const remove =
		(operation === "sending" || operation === "receiving") &&
		method === "DELETE";
	if ((operation === "sending" || operation === "receiving") && !remove)
		return null;
	if (remove) {
		const input = z.object({ target: z.string() }).safeParse(
			await request
				.clone()
				.json()
				.catch(() => null),
		);
		if (!input.success || input.data.target !== "resend") return null;
	}
	const mutation = method === "POST" || remove;
	const domain = await withDatabase((sql) =>
		ownedDomain(sql, user, decodeURIComponent(match[1] ?? ""), mutation),
	);
	const json = (data: unknown, status = 200) =>
		Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
	if (
		mutation &&
		!request.headers.get("Authorization")?.startsWith("Bearer ") &&
		request.headers.get("Sec-Fetch-Site") !== "same-origin" &&
		request.headers.get("Origin") !== publicOrigin()
	)
		return json({ error: "Invalid origin" }, 403);
	try {
		if (operation === "resend" && method === "GET") {
			if (domain.sending_provider !== "resend")
				return json({ error: "Resend is not selected for this domain" }, 400);
			const { apiKey } = await resendKeyStatus();
			if (!apiKey) return json({ keyConfigured: false, resend: null });
			try {
				return json({
					keyConfigured: true,
					resend: await getResendSending(
						domain,
						new ResendClient(apiKey, send),
						api,
					),
				});
			} catch (error) {
				if (error instanceof ResendRestrictedKeyError)
					return json({
						keyConfigured: true,
						canManageDomains: false,
						resend: null,
					});
				throw error;
			}
		}
		if (operation === "receiving/resend" && method === "GET") {
			const key = await resendKeyStatus();
			return json({
				credentials: true,
				view: await getResendReceiving(
					domain,
					publicOrigin(),
					key.apiKey ? new ResendClient(key.apiKey, send) : undefined,
					api,
				),
			});
		}
		if (mutation)
			return await domainOperation(domain.zone_id, async (assertOwned) => {
				const check = () =>
					withDatabase(async (sql) => {
						await assertOwned(sql);
						return ownedDomain(sql, user, domain.id, true);
					});
				const current = await check();
				if (remove) {
					if (
						(operation === "sending"
							? current.sending_provider
							: current.receiving_provider) === "resend"
					)
						return json(
							{ error: "Switch to another provider before removing this one" },
							400,
						);
					const client = new ResendClient(await requireResendKey(), send);
					if (operation === "sending")
						await removeResendSending(current, client, api);
					else await removeResendReceiving(current, client, api);
					await check();
					return json({ ok: true });
				}
				if (operation === "receiving/resend") {
					const client = new ResendClient(await requireResendKey(), send);
					const body = z
						.object({ replaceMx: z.boolean().optional() })
						.parse(await request.json().catch(() => ({})));
					await setupResendReceiving(
						current,
						client,
						publicOrigin(),
						body.replaceMx === true,
						api,
					);
					await check();
					return json({ ok: true });
				}
				const input = z
					.object({ action: z.enum(["setup", "verify", "test"]) })
					.safeParse(await request.json().catch(() => null));
				if (!input.success) return json({ error: "Unknown action" }, 400);
				if (input.data.action === "test") {
					const sent = await sendSystemMail(
						{
							to: user.email,
							subject: "Mailflare test email",
							text: `This message confirms ${current.hostname} can send mail through Resend.`,
							html: "",
							hostname: current.hostname,
						},
						send,
					);
					if (!sent)
						return json(
							{
								error: `Create a mailbox on ${current.hostname} to send the test from.`,
							},
							400,
						);
					await check();
					return json({ ok: true, to: user.email });
				}
				const client = new ResendClient(await requireResendKey(), send);
				const resend =
					input.data.action === "setup"
						? await setupResendSending(current, client, api)
						: await verifyResendSending(current, client, api);
				await check();
				return json({ resend });
			});
		return new Response(null, { status: 405 });
	} catch (error) {
		if (error instanceof Response) throw error;
		if (error instanceof MxConflictError)
			return json(
				{ error: error.message, code: error.code, records: error.records },
				409,
			);
		return json(
			{
				error: error instanceof Error ? error.message : "Resend request failed",
			},
			502,
		);
	}
}
