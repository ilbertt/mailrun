import type { DnsLookup } from "../domains/dns";
import { z } from "zod";
import type { User } from "../../shared/contracts";
import {
	DomainCloudflare,
	MxConflictError,
	findSendingSubdomain,
} from "../domains/cloudflare";
import { domainDto } from "../domains/repository";
import {
	preflightDomain,
	listDomains,
	getDomain,
	domainDnsDetails,
	addDomain,
	removeDomain,
	setupDomainDns,
	setupCloudflareReceiving,
	chooseDomainProvider,
	requireDomainClient,
	removeCloudflareProvider,
} from "../domains/service";
import { CloudflareApiError } from "../cloudflare/client";
import { apiErrorResponse } from "./errors";
const provider = z.enum(["none", "cloudflare", "resend", "ses"]);
export async function domainsApi(
	request: Request,
	user: User,
	client?: DomainCloudflare,
	lookup?: DnsLookup,
): Promise<Response | null> {
	const url = new URL(request.url),
		path = url.pathname,
		method = request.method;
	if (path !== "/api/domains" && !path.startsWith("/api/domains/")) return null;
	try {
		if (path === "/api/domains/check" && method === "POST") {
			const input = z
				.object({ hostname: z.string().min(3) })
				.parse(await request.json());
			return Response.json({
				domain: await preflightDomain(user, input.hostname, client),
			});
		}
		if (path === "/api/domains") {
			if (method === "GET")
				return Response.json(
					await listDomains(
						user,
						url.searchParams.get("includeDns") === "true",
						client,
						lookup,
					),
				);
			if (method === "POST")
				return Response.json(
					await addDomain(user, await request.json(), client, lookup),
				);
			return null;
		}
		const match =
			/^\/api\/domains\/([^/]+)(?:\/(dns(?:\/setup)?|sending|receiving(?:\/[^/]+)?))?$/.exec(
				path,
			);
		if (!match) return null;
		const domainId = decodeURIComponent(match[1] ?? ""),
			operation = match[2];
		if (!operation) {
			if (method === "GET")
				return Response.json({
					domain: domainDto(await getDomain(user, domainId)),
				});
			if (method === "DELETE")
				return Response.json(await removeDomain(user, domainId, client));
		}
		if (operation === "dns" && method === "GET")
			return Response.json(
				await domainDnsDetails(user, domainId, client, lookup),
			);
		if (operation === "dns/setup" && method === "POST") {
			const input = z
				.object({
					record: z.enum(["mx", "spf", "dkim", "dmarc"]),
					replaceMx: z.boolean().optional(),
				})
				.parse(await request.json());
			return Response.json(
				await setupDomainDns(
					user,
					domainId,
					input.record,
					input.replaceMx,
					client,
					lookup,
				),
			);
		}
		if (operation === "receiving/cloudflare" && method === "POST") {
			const input = z
				.object({ replaceMx: z.boolean().optional() })
				.parse(await request.json().catch(() => ({})));
			await setupCloudflareReceiving(user, domainId, input.replaceMx, client);
			return Response.json(
				{ ok: true },
				{ headers: { "Cache-Control": "no-store" } },
			);
		}
		if (operation === "sending" || operation === "receiving") {
			if (method === "PUT") {
				const input = z
					.object({ provider, replaceMx: z.boolean().optional() })
					.parse(await request.json());
				return Response.json(
					await chooseDomainProvider(
						user,
						domainId,
						operation,
						input.provider,
						input.replaceMx,
						client,
					),
					{ headers: { "Cache-Control": "no-store" } },
				);
			}
			if (method === "DELETE") {
				const input = z
					.object({ target: z.enum(["cloudflare", "resend", "ses"]) })
					.parse(await request.json());
				if (input.target === "cloudflare")
					return Response.json(
						await removeCloudflareProvider(user, domainId, operation, client),
					);
				return null;
			}
			if (method === "GET") {
				const domain = await getDomain(user, domainId);
				if (operation === "receiving")
					return Response.json({
						cloudflare: !!domain.routing_enabled,
						resend: null,
						ses: null,
					});
				const api = client ?? (await requireDomainClient().catch(() => null)),
					cloudflare = api
						? await api
								.sending(domain.zone_id)
								.then((rows) => !!findSendingSubdomain(domain.hostname, rows))
								.catch(() => false)
						: false;
				return Response.json(
					{
						cloudflare,
						resend: null,
						resendStatus: null,
						ses: null,
						sesVerified: null,
					},
					{ headers: { "Cache-Control": "no-store" } },
				);
			}
		}
		return null;
	} catch (error) {
		if (error instanceof MxConflictError)
			return Response.json(
				{
					error: error.message,
					code: path === "/api/domains" ? "MX_RECORDS_CONFLICT" : error.code,
					records: error.records,
				},
				{ status: 409 },
			);
		if (error instanceof CloudflareApiError) {
			if (error.errors.some((item) => item.code === 2008))
				return Response.json(
					{
						error:
							"Existing MX records currently deliver mail to another provider. Continue to replace them with Cloudflare Email Routing.",
						code:
							path === "/api/domains" ? "MX_RECORDS_CONFLICT" : "MX_CONFLICT",
					},
					{ status: 409 },
				);
			return Response.json({ error: error.message }, { status: 502 });
		}
		return apiErrorResponse(error);
	}
}
