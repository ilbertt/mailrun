import {
	DomainCloudflare,
	cloudflareAccess,
	MxConflictError,
} from "./cloudflare";
import type { DomainRecord } from "./repository";
export const normalizeDnsValue = (value: string) =>
	value.replace(/^"|"$/g, "").trim().toLowerCase().replace(/\.$/, "");
export const isInboundSmtpMx = (value: string) =>
	/inbound-smtp\.[a-z0-9-]+\.amazonaws\.com\.?$/i.test(value.trim());
export async function providerDnsClient(
	domain: DomainRecord,
	client?: DomainCloudflare,
) {
	if (domain.zone_id === "manual") return null;
	if (client) return client;
	const access = await cloudflareAccess();
	if (!access)
		throw new Error(
			"Configure Cloudflare email during setup before managing DNS",
		);
	return new DomainCloudflare(access);
}
export async function hasProviderMx(
	domain: DomainRecord,
	content: string,
	client?: DomainCloudflare,
) {
	const dns = await providerDnsClient(domain, client);
	return dns
		? (await dns.listDns(domain.zone_id, "MX", domain.hostname)).some(
				(row) =>
					normalizeDnsValue(row.content ?? "") === normalizeDnsValue(content),
			)
		: null;
}
export async function publishProviderMx(
	domain: DomainRecord,
	content: string,
	replace: boolean,
	client?: DomainCloudflare,
	priority = 10,
) {
	const dns = await providerDnsClient(domain, client);
	if (!dns) return;
	const existing = await dns.listDns(domain.zone_id, "MX", domain.hostname),
		others = existing.filter(
			(row) =>
				normalizeDnsValue(row.content ?? "") !== normalizeDnsValue(content),
		);
	if (others.length && !replace)
		throw new MxConflictError(
			others.map((row) => ({
				content: row.content ?? "",
				priority: row.priority ?? 0,
			})),
		);
	for (const row of others)
		if (row.id) await dns.deleteDns(domain.zone_id, row.id);
	if (
		!existing.some(
			(row) =>
				normalizeDnsValue(row.content ?? "") === normalizeDnsValue(content),
		)
	)
		await dns.createDns(domain.zone_id, {
			type: "MX",
			name: domain.hostname,
			content,
			priority,
			ttl: 3600,
		});
}
export async function removeProviderMx(
	domain: DomainRecord,
	matches: (value: string) => boolean,
	client?: DomainCloudflare,
) {
	const dns = await providerDnsClient(domain, client);
	if (!dns) return;
	for (const row of await dns.listDns(domain.zone_id, "MX", domain.hostname))
		if (row.id && matches(row.content ?? ""))
			await dns.deleteDns(domain.zone_id, row.id);
}
