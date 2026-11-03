import { cloudflareCredentials } from "../cloudflare/credentials";
import type { CloudflareAuth } from "../../shared/cloudflare-auth";
import { z } from "zod";
import { canonicalTxt } from "./dns-records";
import { getInstallation } from "../cloudflare/installation";
import { cloudflare, type CloudflareFetch } from "../cloudflare/client";
export const dnsRecordSchema = z.object({
	id: z.string().optional(),
	type: z.string().optional(),
	name: z.string().optional(),
	content: z.string().optional(),
	priority: z.number().optional(),
	ttl: z.number().optional(),
	proxied: z.boolean().optional(),
	comment: z.string().nullable().optional(),
	tags: z.array(z.string()).optional(),
});
export type DnsRecord = z.infer<typeof dnsRecordSchema>;
export const sendingSubdomainSchema = z.object({
	tag: z.string(),
	name: z.string(),
	enabled: z.boolean(),
	dkim_selector: z.string().optional(),
});
export type SendingSubdomain = z.infer<typeof sendingSubdomainSchema>;
export const catchAllSchema = z.object({
	id: z.string().optional(),
	tag: z.string().optional(),
	enabled: z.boolean().optional(),
	name: z.string().optional(),
	source: z.enum(["api", "wrangler"]).optional(),
	owner_worker_tag: z.string().optional(),
	actions: z
		.array(
			z.object({
				type: z.enum(["drop", "forward", "worker"]),
				value: z.array(z.string()).optional(),
			}),
		)
		.optional(),
	matchers: z.array(z.object({ type: z.literal("all") })).optional(),
});
export const routingRuleSchema = z.object({
	id: z.string().optional(),
	tag: z.string().optional(),
	enabled: z.boolean().optional(),
	name: z.string().optional(),
	priority: z.number().optional(),
	source: z.enum(["api", "wrangler"]).optional(),
	owner_worker_tag: z.string().optional(),
	actions: z
		.array(
			z.object({
				type: z.enum(["drop", "forward", "worker"]),
				value: z.array(z.string()).optional(),
			}),
		)
		.optional(),
	matchers: z
		.array(
			z.object({
				type: z.enum(["all", "literal"]),
				field: z.literal("to").optional(),
				value: z.string().optional(),
			}),
		)
		.optional(),
});
export type RoutingRule = z.infer<typeof routingRuleSchema>;
export type CatchAll = z.infer<typeof catchAllSchema>;
export type CloudflareAccess = {
	auth: CloudflareAuth;
	accountId: string | null;
	workerName: string | null;
};
export async function cloudflareAccess(): Promise<CloudflareAccess | null> {
	const installation = await getInstallation(),
		{ auth, accountId } = cloudflareCredentials(installation);
	return auth
		? {
				auth,
				accountId,
				workerName:
					installation && installation.phase !== "saved"
						? installation.worker_name
						: null,
			}
		: null;
}
export function zoneCandidates(hostname: string) {
	const labels = hostname.split(".").filter(Boolean);
	return labels.slice(0, -1).map((_, index) => labels.slice(index).join("."));
}
export function normalizeHostname(value: string) {
	return z
		.string()
		.toLowerCase()
		.trim()
		.transform((name) => name.replace(/\.$/, ""))
		.pipe(
			z.hostname().refine((name) => name.includes("."), "Enter a domain name"),
		)
		.parse(value);
}
export const canonicalDns = (value: string) =>
	value.trim().toLowerCase().replace(/\.$/, "");
export const isCloudflareMx = (record: DnsRecord) =>
	/(^|\.)mx\.cloudflare\.net$/.test(canonicalDns(record.content ?? ""));
export class MxConflictError extends Error {
	readonly code = "MX_CONFLICT";
	constructor(
		readonly records: { content: string; priority: number }[],
		message = "This domain has MX records for another mail service. Replace them to receive mail here.",
	) {
		super(message);
	}
}
export function findSendingSubdomain(
	hostname: string,
	rows: SendingSubdomain[],
) {
	const name = canonicalDns(hostname);
	return (
		rows.find((row) => canonicalDns(row.name) === name) ??
		rows.find(
			(row) =>
				row.name.startsWith("*.") &&
				name !== canonicalDns(row.name.slice(2)) &&
				name.endsWith("." + canonicalDns(row.name.slice(2))),
		) ??
		null
	);
}
export class DomainCloudflare {
	constructor(
		readonly access: CloudflareAccess,
		readonly fetch: CloudflareFetch = globalThis.fetch,
	) {}
	call<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}) {
		return cloudflare(this.access.auth, path, schema, init, this.fetch);
	}
	async findZone(hostname: string) {
		for (const name of zoneCandidates(normalizeHostname(hostname))) {
			const rows = await this.call(
				`/zones?name=${encodeURIComponent(name)}&status=active`,
				z.array(
					z.object({
						id: z.string(),
						name: z.string(),
						account: z.object({ id: z.string() }).optional(),
					}),
				),
			);
			const zone = rows.find(
				(row) =>
					canonicalDns(row.name) === name &&
					(!this.access.accountId || row.account?.id === this.access.accountId),
			);
			if (zone) return zone;
		}
		return null;
	}
	zone(zoneId: string) {
		return this.call(
			`/zones/${encodeURIComponent(zoneId)}`,
			z.object({ id: z.string(), name: z.string() }),
		);
	}
	routing(zoneId: string) {
		return this.call(
			`/zones/${encodeURIComponent(zoneId)}/email/routing`,
			z.object({
				enabled: z.boolean().optional(),
				status: z.string().optional(),
			}),
		);
	}
	enableRouting(zoneId: string, hostname?: string) {
		return this.call(
			`/zones/${encodeURIComponent(zoneId)}/email/routing/dns`,
			z.object({
				enabled: z.boolean().optional(),
				status: z.string().optional(),
			}),
			{
				method: "POST",
				...(hostname ? { body: JSON.stringify({ name: hostname }) } : {}),
			},
		);
	}
	disableRouting(zoneId: string) {
		return this.call(
			`/zones/${encodeURIComponent(zoneId)}/email/routing/dns`,
			z.unknown(),
			{ method: "DELETE" },
		);
	}
	async catchAll(zoneId: string) {
		try {
			return await this.call(
				`/zones/${encodeURIComponent(zoneId)}/email/routing/rules/catch_all`,
				catchAllSchema,
			);
		} catch (error) {
			if (error instanceof CloudflareApiError && error.status === 404)
				return null;
			throw error;
		}
	}
	setCatchAll(zoneId: string, rule: CatchAll) {
		return this.call(
			`/zones/${encodeURIComponent(zoneId)}/email/routing/rules/catch_all`,
			catchAllSchema,
			{
				method: "PUT",
				body: JSON.stringify({
					actions: rule.actions?.length ? rule.actions : [{ type: "drop" }],
					matchers: rule.matchers?.length ? rule.matchers : [{ type: "all" }],
					enabled: rule.enabled ?? false,
					...(rule.name !== undefined ? { name: rule.name } : {}),
					...(rule.source ? { source: rule.source } : {}),
					...(rule.owner_worker_tag
						? { owner_worker_tag: rule.owner_worker_tag }
						: {}),
				}),
			},
		);
	}
	bindRelay(zoneId: string) {
		if (!this.access.workerName)
			throw new Error("Complete email setup before enabling receiving");
		return this.setCatchAll(zoneId, {
			enabled: true,
			name: `Route all email to ${this.access.workerName}`,
			actions: [{ type: "worker", value: [this.access.workerName] }],
			matchers: [{ type: "all" }],
		});
	}
	async routingRules(zoneId: string) {
		const all: RoutingRule[] = [],
			seen = new Set<string>();
		for (let page = 1; page <= 10000; page++) {
			const rows = await this.call(
				`/zones/${encodeURIComponent(zoneId)}/email/routing/rules?per_page=50&page=${page}`,
				z.array(routingRuleSchema),
			);
			let added = 0;
			for (const row of rows) {
				const key = row.id ?? row.tag;
				if (!key)
					throw new CloudflareApiError(
						"Cloudflare returned a routing rule without an id",
						502,
						"/email/routing/rules",
						[],
					);
				if (!seen.has(key)) {
					seen.add(key);
					all.push(row);
					added++;
				}
			}
			if (rows.length && !added)
				throw new Error("Cloudflare repeated a routing-rule page");
			if (rows.length < 50) return all;
		}
		throw new Error("Too many email routing rules");
	}
	updateRoutingRule(zoneId: string, ruleId: string, rule: RoutingRule) {
		return this.call(
			`/zones/${encodeURIComponent(zoneId)}/email/routing/rules/${encodeURIComponent(ruleId)}`,
			routingRuleSchema,
			{
				method: "PUT",
				body: JSON.stringify({
					actions: rule.actions,
					matchers: rule.matchers,
					enabled: rule.enabled,
					name: rule.name,
					priority: rule.priority,
					source: rule.source,
					owner_worker_tag: rule.owner_worker_tag,
				}),
			},
		);
	}
	deleteRoutingRule(zoneId: string, ruleId: string) {
		return this.call(
			`/zones/${encodeURIComponent(zoneId)}/email/routing/rules/${encodeURIComponent(ruleId)}`,
			z.unknown(),
			{ method: "DELETE" },
		);
	}
	async migrateMailflareRules(
		zoneId: string,
		hostname: string,
		changed: { id: string; previous: RoutingRule }[],
	) {
		const workerName = this.access.workerName;
		if (!workerName)
			throw new Error("Complete email setup before enabling receiving");
		for (const rule of await this.routingRules(zoneId)) {
			const ruleId = rule.id ?? rule.tag;
			if (
				!ruleId ||
				!rule.matchers?.some(
					(matcher) =>
						matcher.type === "literal" &&
						matcher.field === "to" &&
						canonicalDns(matcher.value?.split("@").at(-1) ?? "") ===
							canonicalDns(hostname),
				) ||
				!rule.actions?.some(
					(action) =>
						action.type === "worker" && action.value?.includes("mailflare"),
				)
			)
				continue;
			if (rule.source === "wrangler" && !rule.owner_worker_tag)
				throw new Error(
					"A Mailflare routing rule is managed by Wrangler. Move it to API management before migrating it.",
				);
			const actions = rule.actions.map((action) =>
				action.type === "worker"
					? {
							...action,
							value: action.value?.map((worker) =>
								worker === "mailflare" ? workerName : worker,
							),
						}
					: action,
			);
			changed.push({ id: ruleId, previous: rule });
			await this.updateRoutingRule(zoneId, ruleId, {
				...rule,
				actions,
				source: "api",
				owner_worker_tag: undefined,
			});
		}
	}
	listDns(zoneId: string, type: string, name: string) {
		return this.call(
			`/zones/${encodeURIComponent(zoneId)}/dns_records?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}&per_page=5000`,
			z.array(dnsRecordSchema),
		);
	}
	createDns(zoneId: string, record: DnsRecord) {
		return this.call(
			`/zones/${encodeURIComponent(zoneId)}/dns_records`,
			dnsRecordSchema,
			{ method: "POST", body: JSON.stringify(record) },
		);
	}
	deleteDns(zoneId: string, recordId: string) {
		return this.call(
			`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
			z.unknown(),
			{ method: "DELETE" },
		);
	}
	async routingDns(zoneId: string) {
		const result = await this.call(
			`/zones/${encodeURIComponent(zoneId)}/email/routing/dns`,
			z.union([
				z.array(dnsRecordSchema),
				z.object({
					record: z.array(dnsRecordSchema).optional(),
					errors: z
						.array(z.object({ missing: dnsRecordSchema.optional() }))
						.optional(),
				}),
			]),
		);
		if (!Array.isArray(result))
			return {
				records: result.record ?? [],
				missing: (result.errors ?? []).flatMap((error) =>
					error.missing ? [error.missing] : [],
				),
			};
		// Current Cloudflare responses list required records; older responses reported missing ones directly.
		const zone = await this.zone(zoneId),
			actual = new Map<string, DnsRecord[]>();
		await Promise.all(
			[
				...new Set(
					result
						.filter((record) => record.type && record.name)
						.map((record) => JSON.stringify([record.type, record.name])),
				),
			].map(async (key) => {
				const [type, name] = z
					.tuple([z.string(), z.string()])
					.parse(JSON.parse(key));
				actual.set(
					key,
					await this.listDns(zoneId, type, name === "@" ? zone.name : name),
				);
			}),
		);
		return {
			records: result,
			missing: result.filter(
				(record) =>
					record.type &&
					record.name &&
					!actual
						.get(JSON.stringify([record.type, record.name]))
						?.some(
							(candidate) =>
								(record.type?.toUpperCase() === "TXT"
									? canonicalTxt(candidate.content ?? "") ===
										canonicalTxt(record.content ?? "")
									: canonicalDns(candidate.content ?? "") ===
										canonicalDns(record.content ?? "")) &&
								(record.priority === undefined ||
									candidate.priority === record.priority),
						),
			),
		};
	}
	sending(zoneId: string) {
		return this.call(
			`/zones/${encodeURIComponent(zoneId)}/email/sending/subdomains`,
			z.array(sendingSubdomainSchema),
		);
	}
	sendingDns(zoneId: string, tag: string) {
		return this.call(
			`/zones/${encodeURIComponent(zoneId)}/email/sending/subdomains/${encodeURIComponent(tag)}/dns`,
			z.array(dnsRecordSchema),
		);
	}
	createSending(zoneId: string, name: string) {
		return this.call(
			`/zones/${encodeURIComponent(zoneId)}/email/sending/subdomains`,
			sendingSubdomainSchema,
			{ method: "POST", body: JSON.stringify({ name }) },
		);
	}
	deleteSending(zoneId: string, tag: string) {
		return this.call(
			`/zones/${encodeURIComponent(zoneId)}/email/sending/subdomains/${encodeURIComponent(tag)}`,
			z.unknown(),
			{ method: "DELETE" },
		);
	}
	async foreignMx(zoneId: string, hostname: string) {
		return (await this.listDns(zoneId, "MX", hostname)).filter(
			(record) => !isCloudflareMx(record),
		);
	}
	async removeForeignMx(
		zoneId: string,
		hostname: string,
		deleted: DnsRecord[],
	) {
		for (const record of await this.foreignMx(zoneId, hostname)) {
			if (!record.id)
				throw new Error("Cloudflare returned an MX record without an id");
			await this.deleteDns(zoneId, record.id);
			deleted.push(record);
		}
	}
	async restoreMx(zoneId: string, records: DnsRecord[]) {
		for (const record of records) {
			const restored = z
				.object({
					name: z.string().min(1),
					content: z.string().min(1),
					priority: z.number(),
				})
				.parse(record);
			await this.createDns(zoneId, {
				...restored,
				type: "MX",
				ttl: record.ttl ?? 1,
				...(record.proxied !== undefined ? { proxied: record.proxied } : {}),
				...(record.comment !== undefined ? { comment: record.comment } : {}),
				...(record.tags ? { tags: record.tags } : {}),
			});
		}
	}
	async ensureSending(
		zoneId: string,
		hostname: string,
		options: { replaceMx?: boolean; deletedMx?: DnsRecord[] } = {},
	) {
		const existing = findSendingSubdomain(hostname, await this.sending(zoneId));
		if (existing) return { subdomain: existing, created: false };
		try {
			return {
				subdomain: await this.createSending(zoneId, hostname),
				created: true,
			};
		} catch (error) {
			if (
				!(error instanceof CloudflareApiError) ||
				(error.status !== 401 && !error.errors.some((row) => row.code === 2036))
			)
				throw error;
			const foreign = await this.foreignMx(zoneId, hostname).catch(() => []);
			if (!foreign.length) throw error;
			if (!options.replaceMx)
				throw new MxConflictError(
					foreign.map((row) => ({
						content: row.content ?? "",
						priority: row.priority ?? 0,
					})),
					"Cloudflare Email Sending cannot be enabled while this domain has MX records for another mail service. Replace them to send with Cloudflare.",
				);
			await this.removeForeignMx(zoneId, hostname, options.deletedMx ?? []);
			return {
				subdomain: await this.createSending(zoneId, hostname),
				created: true,
			};
		}
	}
}
import { CloudflareApiError } from "../cloudflare/client";
