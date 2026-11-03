import { z } from "zod";
import {
	DomainCloudflare,
	findSendingSubdomain,
	type DnsRecord,
} from "./cloudflare";
import type { DomainRecord } from "./repository";
import type {
	DomainDnsAudit,
	DnsAuthRecord,
	DnsStatusSummary,
} from "../../app/(admin)/domains/types";
export type DnsLookup = (name: string, type: "MX" | "TXT") => Promise<string[]>;
const doh = z.object({
	Status: z.number(),
	Answer: z.array(z.object({ type: z.number(), data: z.string() })).optional(),
});
export async function queryDns(
	name: string,
	type: "MX" | "TXT",
	request: typeof fetch = fetch,
) {
	const response = await request(
		`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
		{
			headers: { Accept: "application/dns-json" },
			signal: AbortSignal.timeout(5000),
		},
	);
	if (!response.ok) throw new Error("DNS lookup failed");
	const data = doh.parse(await response.json());
	if (data.Status !== 0 && data.Status !== 3)
		throw new Error("DNS lookup failed");
	if (data.Status === 3) return [];
	return (data.Answer ?? [])
		.filter((answer) => answer.type === (type === "MX" ? 15 : 16))
		.map((answer) =>
			type === "TXT"
				? (answer.data
						.match(/"([^"]*)"/g)
						?.map((value) => value.slice(1, -1))
						.join("") ?? answer.data.trim())
				: answer.data,
		);
}
export async function auditDomainDns(
	hostname: string,
	view: {
		routing: { records: DnsRecord[]; missing: DnsRecord[] };
		sending: DnsRecord[];
		dkimSelector?: string;
	},
	lookup: DnsLookup = queryDns,
): Promise<DomainDnsAudit> {
	const check = async (
		record: DnsAuthRecord,
		label: string,
		name: string,
		type: "MX" | "TXT",
		matches: (value: string) => boolean,
	) => {
		try {
			const found = (await lookup(name, type)).filter(matches);
			return {
				record,
				label,
				name,
				status: found.length ? ("ok" as const) : ("missing" as const),
				found,
			};
		} catch {
			return { record, label, name, status: "unknown" as const, found: [] };
		}
	};
	const expected = [
			...view.routing.records,
			...view.routing.missing,
			...view.sending,
		],
		dkimName = view.dkimSelector
			? `${view.dkimSelector}._domainkey.${hostname}`
			: expected.find(
					(record) =>
						record.type?.toUpperCase() === "TXT" &&
						/_domainkey/i.test(record.name ?? ""),
				)?.name;
	const [mx, spf, dmarc, dkim] = await Promise.all([
		check(
			"mx",
			"MX",
			hostname,
			"MX",
			(value) => !/^0\s*\.?$/.test(value.trim()),
		),
		check("spf", "SPF", hostname, "TXT", (value) => /v=spf1/i.test(value)),
		check("dmarc", "DMARC", `_dmarc.${hostname}`, "TXT", (value) =>
			/v=DMARC1/i.test(value),
		),
		dkimName
			? check("dkim", "DKIM", dkimName, "TXT", () => true)
			: Promise.resolve({
					record: "dkim" as const,
					label: "DKIM",
					name: `*._domainkey.${hostname}`,
					status: "unknown" as const,
					found: [],
				}),
	]);
	return { mx, spf, dkim, dmarc };
}
export async function domainDns(
	client: DomainCloudflare | null,
	domain: DomainRecord,
	lookup: DnsLookup = queryDns,
) {
	if (domain.zone_id === "manual") {
		const mailHost =
			process.env.MAIL_HOSTNAME?.trim() || `mail.${domain.hostname}`;
		const view = {
			routing: {
				relayReady: true,
				records: [] as DnsRecord[],
				missing: [
					{
						type: "MX",
						name: domain.hostname,
						content: `10 ${mailHost}`,
						ttl: 3600,
					},
					{
						type: "TXT",
						name: domain.hostname,
						content: `v=spf1 a:${mailHost} ~all`,
						ttl: 3600,
					},
					{
						type: "TXT",
						name: `_dmarc.${domain.hostname}`,
						content: "v=DMARC1; p=none",
						ttl: 3600,
					},
				],
				status: "manual",
			},
			sending: [] as DnsRecord[],
			sendingEnabled: false,
		};
		return {
			...view,
			audit: await auditDomainDns(domain.hostname, view, lookup),
		};
	}
	if (!client)
		throw new Error(
			"Configure Cloudflare email during setup before managing DNS",
		);
	const [routing, settings, identities] = await Promise.all([
			client.routingDns(domain.zone_id),
			client.routing(domain.zone_id),
			client.sending(domain.zone_id).catch(() => []),
		]),
		identity = findSendingSubdomain(domain.hostname, identities),
		sending = identity?.tag
			? await client.sendingDns(domain.zone_id, identity.tag).catch(() => [])
			: [];
	const view = {
		routing: {
			...routing,
			status: settings.status,
			relayReady:
				!!client.access.workerName &&
				domain.mailrun_relay_worker_name === client.access.workerName &&
				domain.mailrun_relay_zone_id === domain.zone_id,
		},
		sending,
		sendingEnabled: identity?.enabled ?? false,
		dkimSelector: identity?.dkim_selector,
		sendingSubdomain: identity
			? { name: identity.name, tag: identity.tag }
			: undefined,
	};
	return {
		...view,
		audit: await auditDomainDns(domain.hostname, view, lookup),
	};
}
export function summarizeDomainDns(
	view: Awaited<ReturnType<typeof domainDns>>,
	domain: DomainRecord,
): DnsStatusSummary {
	return {
		routing: {
			configured:
				view.routing.relayReady &&
				view.routing.missing.length === 0 &&
				(view.routing.records.length > 0 || !!domain.routing_enabled),
			missing: [
				...new Set(
					view.routing.missing.flatMap((record) =>
						record.type ? [record.type] : [],
					),
				),
			],
		},
		sending: {
			configured: view.sendingEnabled,
			records: [
				...new Set(
					view.sending.flatMap((record) => (record.type ? [record.type] : [])),
				),
			],
		},
		auth: {
			mx: view.audit.mx.status,
			spf: view.audit.spf.status,
			dkim: view.audit.dkim.status,
			dmarc: view.audit.dmarc.status,
		},
	};
}
