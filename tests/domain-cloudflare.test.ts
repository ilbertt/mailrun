import { test, expect, beforeEach, afterEach } from "bun:test";
import { fixture, owner } from "./fixtures";
import {
	DomainCloudflare,
	MxConflictError,
	cloudflareAccess,
	findSendingSubdomain,
	normalizeHostname,
	zoneCandidates,
	isCloudflareMx,
	type CloudflareAccess,
	type DnsRecord,
	type RoutingRule,
} from "../src/server/domains/cloudflare";
import {
	CloudflareApiError,
	type CloudflareFetch,
} from "../src/server/cloudflare/client";
import { provisionCloudflareDomain } from "../src/server/domains/provision";
import {
	saveInstallation,
	setInstallationPhase,
} from "../src/server/cloudflare/installation";
import { dispatchMailApi } from "../src/server/api/mail";
let state: Awaited<ReturnType<typeof fixture>>;
const keys = ["CF_TOKEN", "CF_ACCOUNT_ID", "CF_EMAIL_WORKER_NAME"] as const;
let environment: Record<string, string | undefined>;
beforeEach(async () => {
	state = await fixture();
	environment = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
});
afterEach(async () => {
	for (const key of keys) {
		if (environment[key] === undefined) delete process.env[key];
		else process.env[key] = environment[key];
	}
	await state.close();
});
const access: CloudflareAccess = {
	apiToken: "synthetic-token",
	accountId: "account",
	workerName: "mailrun-relay",
};
const success = (result: unknown) => Response.json({ success: true, result });
const failure = (status: number, code = 1000) =>
	Response.json(
		{
			success: false,
			result: null,
			errors: [{ code, message: "Synthetic Cloudflare failure" }],
		},
		{ status },
	);
type Call = { path: string; method: string; body: unknown };
function server(
	options: {
		enabled?: boolean;
		foreign?: boolean;
		existingSending?: boolean;
		sendingFailure?: boolean;
		bindFailure?: boolean;
		cleanupFailure?: boolean;
	} = {},
) {
	const calls: Call[] = [],
		rules: RoutingRule[] = [],
		prior = {
			enabled: true,
			name: "Previous routing",
			actions: [{ type: "forward", value: ["previous@example.net"] }],
			matchers: [{ type: "all" }],
		};
	const mx: DnsRecord[] = [
		{
			id: "cf-mx",
			type: "MX",
			name: "example.com",
			content: "route1.mx.cloudflare.net.",
			priority: 10,
			ttl: 1,
		},
		...(options.foreign
			? [
					{
						id: "other-mx",
						type: "MX",
						name: "example.com",
						content: "mx.other.example",
						priority: 5,
						ttl: 3600,
						comment: "Previous mail",
						tags: ["managed:mail"],
					},
				]
			: []),
	];
	const fetch: CloudflareFetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input)),
			path = url.pathname.replace("/client/v4", "") + url.search,
			method = init?.method ?? "GET",
			body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
		calls.push({ path, method, body });
		if (path.startsWith("/zones?"))
			return success([
				{ id: "zone", name: "example.com", account: { id: "account" } },
			]);
		if (path === "/zones/zone" && method === "GET")
			return success({ id: "zone", name: "example.com" });
		if (path === "/zones/zone/email/routing" && method === "GET")
			return success({ enabled: options.enabled ?? false, status: "ready" });
		if (path === "/zones/zone/email/routing/rules/catch_all") {
			if (method === "GET") return success(prior);
			if (
				options.bindFailure &&
				body?.enabled &&
				body?.actions?.[0]?.type === "worker"
			)
				return failure(500);
			return success(body);
		}
		if (path.startsWith("/zones/zone/email/routing/rules?"))
			return success(rules);
		const ruleMatch = /^\/zones\/zone\/email\/routing\/rules\/([^?]+)$/.exec(
			path,
		);
		if (ruleMatch && method === "PUT") {
			const index = rules.findIndex(
				(row) => (row.id ?? row.tag) === ruleMatch[1],
			);
			if (index < 0) throw new Error("Missing fixture rule");
			rules[index] = { ...body, id: ruleMatch[1] };
			return success(rules[index]);
		}
		if (path.startsWith("/zones/zone/dns_records?")) return success(mx);
		if (path === "/zones/zone/dns_records/other-mx" && method === "DELETE") {
			mx.splice(
				mx.findIndex((record) => record.id === "other-mx"),
				1,
			);
			return success(null);
		}
		if (path === "/zones/zone/dns_records" && method === "POST") {
			if (options.cleanupFailure) return failure(500);
			mx.push(body);
			return success({ ...body, id: "restored" });
		}
		if (path === "/zones/zone/email/routing/dns") {
			if (method === "DELETE" && options.cleanupFailure) return failure(500);
			return success({ enabled: true, status: "ready" });
		}
		if (path === "/zones/zone/email/sending/subdomains" && method === "GET")
			return success(
				options.existingSending
					? [{ tag: "existing", name: "example.com", enabled: true }]
					: [],
			);
		if (path === "/zones/zone/email/sending/subdomains" && method === "POST")
			return options.sendingFailure
				? failure(500)
				: success({ tag: "created", name: body.name, enabled: true });
		if (
			path.startsWith("/zones/zone/email/sending/subdomains/") &&
			method === "DELETE"
		)
			return success(null);
		throw new Error(`Unexpected request ${method} ${path}`);
	};
	return {
		client: new DomainCloudflare({ ...access }, fetch),
		calls,
		prior,
		mx,
		rules,
	};
}
test("setup-saved credentials enable original DNS management without environment credentials", async () => {
	expect(await cloudflareAccess()).toBeNull();
	await saveInstallation({
		accountId: "account",
		zoneId: "zone",
		hostname: "example.com",
		workerName: "saved-relay",
		publicOrigin: "https://fixture.example",
		apiToken: "saved-token",
		relaySecret: "synthetic-secret",
		relayVersion: "test",
	});
	expect((await cloudflareAccess())?.workerName).toBeNull();
	await setInstallationPhase("deployed");
	expect(await cloudflareAccess()).toEqual({
		apiToken: "saved-token",
		accountId: "account",
		workerName: "saved-relay",
	});
	expect(
		await (
			await dispatchMailApi(new Request("http://localhost/api/auth/me"), owner)
		).json(),
	).toMatchObject({ managesDns: true });
});
test("environment credentials remain usable before setup and saved credentials take precedence", async () => {
	process.env.CF_TOKEN = " environment-token ";
	process.env.CF_ACCOUNT_ID = "account";
	process.env.CF_EMAIL_WORKER_NAME = "relay";
	expect(await cloudflareAccess()).toEqual({
		apiToken: "environment-token",
		accountId: "account",
		workerName: null,
	});
});
test("zone lookup walks subdomains, filters the configured account and normalizes hostnames", async () => {
	const paths: string[] = [];
	const client = new DomainCloudflare(access, async (input) => {
		const url = new URL(String(input));
		paths.push(url.searchParams.get("name") ?? "");
		return success(
			url.searchParams.get("name") === "example.com"
				? [
						{ id: "wrong", name: "example.com", account: { id: "other" } },
						{ id: "right", name: "example.com", account: { id: "account" } },
					]
				: [],
		);
	});
	expect(await client.findZone(" MAIL.Example.com. ")).toMatchObject({
		id: "right",
	});
	expect(paths).toEqual(["mail.example.com", "example.com"]);
	expect(zoneCandidates("a.b.example.com")).toEqual([
		"a.b.example.com",
		"b.example.com",
		"example.com",
	]);
	expect(normalizeHostname("EXAMPLE.COM.")).toBe("example.com");
	expect(() => normalizeHostname("example.com/path")).toThrow();
});
test("typed Cloudflare errors retain status and service codes for conflict handling", async () => {
	const client = new DomainCloudflare(access, async () => failure(401, 2036));
	try {
		await client.sending("zone");
		throw new Error("Expected failure");
	} catch (error) {
		expect(error).toBeInstanceOf(CloudflareApiError);
		expect(error).toMatchObject({ status: 401, errors: [{ code: 2036 }] });
	}
});
test("DNS views support current record arrays and the source legacy missing-record response", async () => {
	const required: [DnsRecord, DnsRecord] = [
		{
			type: "MX",
			name: "@",
			content: "route1.mx.cloudflare.net",
			priority: 10,
		},
		{
			type: "TXT",
			name: "example.com",
			content: "v=spf1 include:_spf.mx.cloudflare.net ~all",
		},
	];
	const client = new DomainCloudflare(access, async (input) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("/email/routing/dns")) return success(required);
		if (url.pathname === "/client/v4/zones/zone")
			return success({ id: "zone", name: "example.com" });
		return success(
			url.searchParams.get("type") === "MX"
				? [
						{
							type: "MX",
							name: "example.com",
							content: "ROUTE1.MX.CLOUDFLARE.NET.",
							priority: 10,
						},
					]
				: [],
		);
	});
	expect(await client.routingDns("zone")).toEqual({
		records: required,
		missing: [required[1]],
	});
	const legacy = new DomainCloudflare(access, async () =>
		success({ record: [required[0]], errors: [{ missing: required[1] }] }),
	);
	expect(await legacy.routingDns("zone")).toEqual({
		records: [required[0]],
		missing: [required[1]],
	});
});
test("sending reuses exact or wildcard identities without duplicating provider configuration", async () => {
	const wildcard = { tag: "wild", name: "*.example.com", enabled: true },
		exact = { tag: "exact", name: "mail.example.com", enabled: true };
	expect(findSendingSubdomain("MAIL.example.com", [wildcard, exact])?.tag).toBe(
		"exact",
	);
	expect(findSendingSubdomain("example.com", [wildcard])).toBeNull();
	let requests = 0;
	const client = new DomainCloudflare(access, async () => {
		requests++;
		return success([wildcard]);
	});
	expect(await client.ensureSending("zone", "mail.example.com")).toEqual({
		subdomain: wildcard,
		created: false,
	});
	expect(requests).toBe(1);
});
test("foreign MX records require explicit replacement consent before routing changes", async () => {
	const mock = server({ foreign: true });
	await expect(
		provisionCloudflareDomain(mock.client, "example.com"),
	).rejects.toBeInstanceOf(MxConflictError);
	expect(mock.calls.filter((call) => call.method !== "GET")).toEqual([]);
	expect(mock.mx).toHaveLength(2);
	expect(isCloudflareMx({ content: "route1.mx.cloudflare.net." })).toBe(true);
	expect(
		isCloudflareMx({ content: "route1.mx.cloudflare.net.evil.example" }),
	).toBe(false);
});
test("subdomain receiving binds the setup relay and existing sending is reused", async () => {
	const mock = server({ existingSending: true });
	const result = await provisionCloudflareDomain(
		mock.client,
		"mail.example.com",
	);
	expect(result).toMatchObject({
		hostname: "mail.example.com",
		routingEnabled: true,
		sendingEnabled: true,
	});
	expect(
		mock.calls.find(
			(call) =>
				call.path.endsWith("/email/routing/dns") && call.method === "POST",
		)?.body,
	).toEqual({ name: "mail.example.com" });
	expect(
		mock.calls.find(
			(call) => call.path.endsWith("/catch_all") && call.method === "PUT",
		)?.body,
	).toMatchObject({
		actions: [{ type: "worker", value: ["mailrun-relay"] }],
		enabled: true,
	});
});
test("failed provisioning restores previous routing and deleted MX metadata", async () => {
	const mock = server({ foreign: true, sendingFailure: true });
	await expect(
		provisionCloudflareDomain(mock.client, "example.com", {
			replaceMxRecords: true,
		}),
	).rejects.toBeInstanceOf(CloudflareApiError);
	expect(
		mock.calls.findLast(
			(call) => call.path.endsWith("/catch_all") && call.method === "PUT",
		)?.body,
	).toEqual(mock.prior);
	expect(
		mock.calls.some(
			(call) =>
				call.method === "DELETE" && call.path.endsWith("/email/routing/dns"),
		),
	).toBe(true);
	expect(
		mock.mx.find((record) => record.content === "mx.other.example"),
	).toMatchObject({
		priority: 5,
		ttl: 3600,
		comment: "Previous mail",
		tags: ["managed:mail"],
	});
	expect(
		mock.calls.filter((call) => call.path === "/zones/zone/dns_records/cf-mx"),
	).toEqual([]);
});
test("rollback leaves previously enabled routing intact and reports cleanup failures", async () => {
	const enabled = server({ enabled: true, sendingFailure: true });
	await expect(
		provisionCloudflareDomain(enabled.client, "example.com"),
	).rejects.toBeInstanceOf(CloudflareApiError);
	expect(
		enabled.calls.some(
			(call) =>
				call.method === "DELETE" && call.path.endsWith("/email/routing/dns"),
		),
	).toBe(false);
	const cleanup = server({ sendingFailure: true, cleanupFailure: true });
	await expect(
		provisionCloudflareDomain(cleanup.client, "example.com"),
	).rejects.toBeInstanceOf(AggregateError);
	expect(
		cleanup.calls.findLast(
			(call) => call.path.endsWith("/catch_all") && call.method === "PUT",
		)?.body,
	).toEqual(cleanup.prior);
});
test("an undeployed relay or unreadable catch-all never changes live routing", async () => {
	const missing = server();
	missing.client.access.workerName = null;
	await expect(
		provisionCloudflareDomain(missing.client, "example.com"),
	).rejects.toThrow("Complete email setup");
	expect(missing.calls.filter((call) => call.method !== "GET")).toEqual([]);
	missing.client.access.workerName = "mailrun-relay";
	const unreadable = new DomainCloudflare(access, async (input) => {
		const path = new URL(String(input)).pathname;
		if (path.endsWith("/catch_all")) return failure(403);
		if (path.endsWith("/email/routing")) return success({ enabled: true });
		return success([
			{ id: "zone", name: "example.com", account: { id: "account" } },
		]);
	});
	await expect(
		provisionCloudflareDomain(unreadable, "example.com"),
	).rejects.toMatchObject({ status: 403 });
});

test("malformed provider responses are upstream failures rather than invalid user input", async () => {
	const html = new DomainCloudflare(
		access,
		async () => new Response("Service unavailable", { status: 503 }),
	);
	await expect(html.sending("zone")).rejects.toMatchObject({
		status: 503,
		name: "CloudflareApiError",
	});
	const wrongShape = new DomainCloudflare(access, async () =>
		success([{ tag: 12 }]),
	);
	await expect(wrongShape.sending("zone")).rejects.toMatchObject({
		status: 502,
		name: "CloudflareApiError",
	});
});
