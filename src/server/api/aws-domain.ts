import { z } from "zod";
import type { User } from "../../shared/contracts";
import type { CloudflareFetch } from "../cloudflare/client";
import { MxConflictError, type DomainCloudflare } from "../domains/cloudflare";
import { ownedDomain, domainOperation } from "../domains/repository";
import { withDatabase } from "../db";
import { publicOrigin } from "../config";
import { AwsClient, AwsError } from "../aws/client";
import { getAwsConfig, requireAwsConfig } from "../aws/settings";
import {
	sesSendingView,
	setupSesSending,
	removeSesSending,
	sesReceivingView,
	setupSesReceiving,
	removeSesReceiving,
} from "../aws/domains";
import { sendSystemMail } from "../mail/system";
export async function awsDomainApi(
	request: Request,
	user: User,
	api?: DomainCloudflare,
	send: CloudflareFetch = fetch,
): Promise<Response | null> {
	const url = new URL(request.url),
		match =
			/^\/api\/domains\/([^/]+)\/(ses|receiving\/ses|sending|receiving)$/.exec(
				url.pathname,
			);
	if (!match) return null;
	const operation = match[2],
		method = request.method,
		remove =
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
		if (!input.success || input.data.target !== "ses") return null;
	}
	const mutation = method === "POST" || remove,
		domain = await withDatabase((sql) =>
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
		if (method === "GET") {
			const config = await getAwsConfig();
			if (!config)
				return json(
					operation === "ses"
						? { credentials: false, ses: null }
						: { credentials: false, view: null },
				);
			const client = new AwsClient(config, send);
			if (operation === "receiving/ses")
				return json({
					credentials: true,
					view: await sesReceivingView(domain, client, api),
				});
			try {
				return json({
					credentials: true,
					ses: await sesSendingView(domain, client, api),
				});
			} catch (error) {
				if (error instanceof AwsError && error.accessDenied)
					return json({
						credentials: true,
						ses: null,
						error:
							"These AWS credentials cannot manage SES identities. Re-check them under AWS credentials.",
					});
				throw error;
			}
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
							: current.receiving_provider) === "ses"
					)
						return json(
							{ error: "Switch to another provider before removing this one" },
							400,
						);
					const client = new AwsClient(await requireAwsConfig(), send);
					if (operation === "sending")
						await removeSesSending(current, client, api);
					else await removeSesReceiving(current, client, api);
					await check();
					return json({ ok: true });
				}
				if (operation === "receiving/ses") {
					const input = z
						.object({ replaceMx: z.boolean().optional() })
						.parse(await request.json().catch(() => ({})));
					await setupSesReceiving(
						current,
						new AwsClient(await requireAwsConfig(), send),
						publicOrigin(),
						input.replaceMx === true,
						api,
						async (sql) => {
							await assertOwned(sql);
							await ownedDomain(sql, user, current.id, true);
						},
					);
					await check();
					return json({ ok: true });
				}
				const input = z
					.object({ action: z.enum(["test", "setup", "verify"]) })
					.safeParse(await request.json().catch(() => null));
				if (!input.success) return json({ error: "Unknown action" }, 400);
				if (input.data.action === "test") {
					const sent = await sendSystemMail(
						{
							to: user.email,
							subject: "Mailflare test email",
							text: `This message confirms ${current.hostname} can send mail through Amazon SES.`,
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
				const client = new AwsClient(await requireAwsConfig(), send),
					ses =
						input.data.action === "setup"
							? await setupSesSending(current, client, api)
							: await sesSendingView(current, client, api);
				await check();
				return json({ ses });
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
			{ error: error instanceof Error ? error.message : "AWS request failed" },
			502,
		);
	}
}
