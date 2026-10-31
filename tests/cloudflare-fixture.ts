import { z } from "zod";
import {
	DomainCloudflare,
	canonicalDns,
	isCloudflareMx,
	dnsRecordSchema,
	routingRuleSchema,
	catchAllSchema,
	type CloudflareAccess,
	type DnsRecord,
	type RoutingRule,
	type CatchAll,
	type SendingSubdomain,
} from "../src/server/domains/cloudflare";
import type { CloudflareFetch } from "../src/server/cloudflare/client";
const zoneSchema = z.object({
	id: z.string(),
	name: z.string(),
	account: z.object({ id: z.string() }),
});
export function cloudflareFixture() {
	const access: CloudflareAccess = {
			auth: { kind: "token" as const, token: "fixture-token" },
			accountId: "account",
			workerName: "mailrun-relay",
		},
		zones = [{ id: "zone", name: "example.com", account: { id: "account" } }],
		records: DnsRecord[] = [],
		rules: RoutingRule[] = [],
		identities: SendingSubdomain[] = [],
		calls: { method: string; path: string; body: unknown }[] = [],
		routing = new Map<string, boolean>(),
		catchAlls = new Map<string, CatchAll>();
	const routingRecords = new Map<string, Set<string>>(),
		sendingRecords = new Map<string, Set<string>>();
	let sequence = 0;
	const success = (result?: unknown) =>
			Response.json({
				success: true,
				...(result === undefined ? {} : { result }),
			}),
		error = (status: number, code: number, message: string) =>
			Response.json(
				{ success: false, errors: [{ code, message }] },
				{ status },
			);
	const same = (a: string, b: string) => canonicalDns(a) === canonicalDns(b);
	const byName = (name: string, type?: string) =>
		records.filter(
			(record) =>
				same(record.name ?? "", name) && (!type || record.type === type),
		);
	const addRecord = (record: DnsRecord) => {
		const row = { ...record, id: record.id ?? "dns-" + ++sequence };
		records.push(row);
		return row;
	};
	const required = (name: string): DnsRecord[] => [
		{
			type: "MX",
			name,
			content: "route1.mx.cloudflare.net",
			priority: 10,
			ttl: 1,
		},
		{
			type: "TXT",
			name,
			content: "v=spf1 include:_spf.mx.cloudflare.net ~all",
			ttl: 1,
		},
	];
	const bodyObject = z.object({ name: z.string().optional() });
	const fetch: CloudflareFetch = async (input, init) => {
		const request =
				input instanceof Request && !init ? input : new Request(input, init),
			url = new URL(request.url),
			method = request.method,
			body: unknown = request.body ? await request.json() : undefined,
			path = url.pathname.replace(/^\/client\/v4/, "");
		calls.push({ method, path: path + url.search, body });
		if (path === "/dns-query") {
			const name = url.searchParams.get("name") ?? "",
				type = url.searchParams.get("type") ?? "TXT";
			return Response.json({
				Status: 0,
				Answer: byName(name, type).map((record) => ({
					name,
					type: type === "MX" ? 15 : 16,
					TTL: 60,
					data:
						type === "MX"
							? `${record.priority ?? 0} ${record.content ?? ""}`
							: `"${record.content ?? ""}"`,
				})),
			});
		}
		if (path === "/zones" && method === "GET")
			return success(
				zones.filter((zone) => zone.name === url.searchParams.get("name")),
			);
		const route = /^\/zones\/([^/]+)(.*)$/.exec(path);
		if (!route) return error(404, 1000, "Unknown fixture endpoint");
		const zone = zones.find((row) => row.id === route[1]);
		if (!zone) return error(404, 1000, "Unknown zone");
		const tail = route[2] ?? "";
		if (!tail && method === "GET") return success(zoneSchema.parse(zone));
		if (tail === "/email/routing" && method === "GET")
			return success({
				enabled: routing.get(zone.id) ?? false,
				status: routing.get(zone.id) ? "ready" : "unconfigured",
			});
		if (tail === "/email/routing/dns") {
			if (method === "GET") {
				const expected = required(zone.name);
				return success({
					record: expected,
					errors: expected
						.filter(
							(record) =>
								!byName(record.name ?? "", record.type).some((existing) =>
									same(existing.content ?? "", record.content ?? ""),
								),
						)
						.map((missing) => ({ missing })),
				});
			}
			if (method === "POST") {
				const name = bodyObject.parse(body ?? {}).name ?? zone.name,
					foreign = byName(name, "MX").filter(
						(record) => !isCloudflareMx(record),
					);
				if (foreign.length)
					return error(400, 2008, "Existing MX records conflict");
				for (const record of required(name))
					if (
						!byName(name, record.type).some((existing) =>
							same(existing.content ?? "", record.content ?? ""),
						)
					) {
						const made = addRecord(record),
							owned = routingRecords.get(zone.id) ?? new Set<string>();
						owned.add(made.id);
						routingRecords.set(zone.id, owned);
					}
				routing.set(zone.id, true);
				return success({ enabled: true, status: "ready" });
			}
			if (method === "DELETE") {
				routing.set(zone.id, false);
				const owned = routingRecords.get(zone.id);
				for (let index = records.length - 1; index >= 0; index--) {
					const item = records[index];
					if (item?.id && owned?.has(item.id)) records.splice(index, 1);
				}
				routingRecords.delete(zone.id);
				return success();
			}
		}
		if (tail === "/email/routing/rules/catch_all") {
			if (method === "GET")
				return success(
					catchAlls.get(zone.id) ?? {
						enabled: false,
						actions: [{ type: "drop" }],
						matchers: [{ type: "all" }],
					},
				);
			if (method === "PUT") {
				const value = catchAllSchema.parse(body);
				catchAlls.set(zone.id, value);
				return success(value);
			}
		}
		if (tail === "/email/routing/rules") {
			if (method === "GET") {
				const perPage = Number(url.searchParams.get("per_page") ?? 20),
					page = Number(url.searchParams.get("page") ?? 1);
				return success(rules.slice((page - 1) * perPage, page * perPage));
			}
			if (method === "POST") {
				const value = {
					...routingRuleSchema.parse(body),
					id: "rule-" + ++sequence,
				};
				rules.push(value);
				return success(value);
			}
		}
		const rule = /^\/email\/routing\/rules\/([^/]+)$/.exec(tail);
		if (rule) {
			const index = rules.findIndex(
				(item) => (item.id ?? item.tag) === rule[1],
			);
			if (index < 0) return error(404, 1000, "Missing rule");
			if (method === "DELETE") {
				rules.splice(index, 1);
				return success();
			}
			if (method === "PUT") {
				const value = { ...routingRuleSchema.parse(body), id: rule[1] };
				rules[index] = value;
				return success(value);
			}
		}
		if (tail === "/dns_records") {
			if (method === "GET")
				return success(
					byName(
						url.searchParams.get("name") ?? zone.name,
						url.searchParams.get("type") ?? undefined,
					),
				);
			if (method === "POST")
				return success(addRecord(dnsRecordSchema.parse(body)));
		}
		const dns = /^\/dns_records\/([^/]+)$/.exec(tail);
		if (dns && method === "DELETE") {
			const index = records.findIndex((record) => record.id === dns[1]);
			if (index >= 0) records.splice(index, 1);
			return success();
		}
		if (tail === "/email/sending/subdomains") {
			if (method === "GET") return success(identities);
			if (method === "POST") {
				const { name } = z.object({ name: z.string() }).parse(body);
				if (byName(name, "MX").some((record) => !isCloudflareMx(record)))
					return error(401, 2036, "Foreign MX prevents sending");
				const value = {
					tag: "sending-" + ++sequence,
					name,
					enabled: true,
					dkim_selector: "cf2026",
				};
				identities.push(value);
				const made = addRecord({
					type: "TXT",
					name: `${value.dkim_selector}._domainkey.${name}`,
					content: "v=DKIM1; p=fixture",
					ttl: 1,
				});
				sendingRecords.set(value.tag, new Set([made.id]));
				return success(value);
			}
		}
		const sending = /^\/email\/sending\/subdomains\/([^/]+)(?:\/dns)?$/.exec(
			tail,
		);
		if (sending) {
			const identity = identities.find((row) => row.tag === sending[1]);
			if (!identity) return error(404, 1000, "Missing identity");
			if (method === "GET")
				return success(
					byName(
						`${identity.dkim_selector ?? "cf2026"}._domainkey.${identity.name}`,
						"TXT",
					),
				);
			if (method === "DELETE") {
				identities.splice(identities.indexOf(identity), 1);
				const owned = sendingRecords.get(identity.tag);
				for (let index = records.length - 1; index >= 0; index--) {
					const record = records[index];
					if (record?.id && owned?.has(record.id)) records.splice(index, 1);
				}
				sendingRecords.delete(identity.tag);
				return success();
			}
		}
		return error(404, 1000, `Unknown fixture path ${method} ${tail}`);
	};
	const lookup = async (name: string, type: "MX" | "TXT") =>
		byName(name, type).map((record) =>
			type === "MX"
				? `${record.priority ?? 0} ${record.content ?? ""}`
				: (record.content ?? ""),
		);
	return {
		access,
		client: new DomainCloudflare(access, fetch),
		fetch,
		lookup,
		zones,
		records,
		rules,
		identities,
		calls,
		routing,
		catchAlls,
		addRecord,
	};
}
