import { test, expect, beforeEach, afterEach } from "bun:test";
import { fixture, owner, stranger } from "./fixtures";
import { cloudflareFixture } from "./cloudflare-fixture";
import {
	addDomain,
	listDomains,
	getDomain,
	setupDomainDns,
	chooseDomainProvider,
	removeDomain,
	removeCloudflareProvider,
} from "../src/server/domains/service";
import {
	domainOperation,
	clearDomainRuntimeLeases,
} from "../src/server/domains/repository";
import {
	DomainCloudflare,
	MxConflictError,
} from "../src/server/domains/cloudflare";
import { provisionCloudflareDomain } from "../src/server/domains/provision";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
test("domain provisioning retains the source contract, mailbox identity and independent DNS audit", async () => {
	const cf = cloudflareFixture();
	const saved = await addDomain(
		owner,
		{
			hostname: "EXAMPLE.COM",
			receivingProvider: "cloudflare",
			sendingProvider: "cloudflare",
		},
		cf.client,
		cf.lookup,
	);
	expect(saved.domain).toMatchObject({
		id: "domain",
		hostname: "example.com",
		routingEnabled: true,
		sendingEnabled: true,
		sendingProvider: "cloudflare",
		receivingProvider: "cloudflare",
		status: "active",
	});
	expect(saved.dns).toMatchObject({
		audit: {
			mx: { status: "ok" },
			spf: { status: "ok" },
			dkim: { status: "ok" },
			dmarc: { status: "missing" },
		},
	});
	expect(state.db.query("SELECT id FROM mailboxes").all()).toEqual([
		{ id: "mailbox" },
	]);
	expect(
		(await listDomains(owner, true, cf.client, cf.lookup)).dns?.domain,
	).toMatchObject({ routing: { configured: true }, auth: { dkim: "ok" } });
	expect((await listDomains(stranger)).domains).toEqual([]);
});
test("DNS setup is idempotent and receipt setup does not enable sending", async () => {
	const cf = cloudflareFixture();
	await setupDomainDns(owner, "domain", "mx", false, cf.client, cf.lookup);
	expect(cf.identities).toHaveLength(0);
	expect((await getDomain(owner, "domain")).routing_enabled).toBe(1);
	await setupDomainDns(owner, "domain", "dkim", false, cf.client, cf.lookup);
	await setupDomainDns(owner, "domain", "dkim", false, cf.client, cf.lookup);
	expect(cf.identities).toHaveLength(1);
	await setupDomainDns(owner, "domain", "dmarc", false, cf.client, cf.lookup);
	const ready = await setupDomainDns(
		owner,
		"domain",
		"dmarc",
		false,
		cf.client,
		cf.lookup,
	);
	expect(
		cf.records.filter((row) => row.name === "_dmarc.example.com"),
	).toHaveLength(1);
	expect(ready.dns.audit.dmarc.status).toBe("ok");
});
test("unprivileged and cross-owner requests cannot mutate or claim a shared Cloudflare zone", async () => {
	const cf = cloudflareFixture();
	await expect(
		addDomain(stranger, { hostname: "example.com" }, cf.client, cf.lookup),
	).rejects.toMatchObject({ status: 403 });
	await expect(
		setupDomainDns(stranger, "domain", "mx", false, cf.client, cf.lookup),
	).rejects.toMatchObject({ status: 403 });
	expect(cf.calls).toHaveLength(0);
	state.db.exec(
		"UPDATE users SET role='admin',can_manage_domains=1 WHERE id='stranger'",
	);
	await expect(
		addDomain(stranger, { hostname: "sub.example.com" }, cf.client, cf.lookup),
	).rejects.toMatchObject({ status: 409 });
	expect(cf.calls.filter((call) => call.method !== "GET")).toEqual([]);
	await expect(getDomain(stranger, "domain")).rejects.toMatchObject({
		status: 404,
	});
});
test("delegated mailbox managers see their creator domain list while DNS details remain owner-only", async () => {
	state.db.exec(
		"UPDATE users SET can_manage_mailboxes=1,created_by_user_id='owner' WHERE id='stranger'",
	);
	expect(
		(await listDomains(stranger)).domains.map((domain) => domain.id),
	).toEqual(["domain"]);
	await expect(getDomain(stranger, "domain")).rejects.toMatchObject({
		status: 404,
	});
});
test("MX conflicts require consent, preserve addresses, and keep the sending choice on declined setup", async () => {
	const cf = cloudflareFixture();
	cf.addRecord({
		type: "MX",
		name: "example.com",
		content: "mx.old.example",
		priority: 5,
		ttl: 3600,
	});
	await expect(
		addDomain(owner, { hostname: "example.com" }, cf.client, cf.lookup),
	).rejects.toBeInstanceOf(MxConflictError);
	expect(cf.calls.filter((call) => call.method !== "GET")).toEqual([]);
	state.db.exec("UPDATE domains SET sending_provider='none'");
	await expect(
		chooseDomainProvider(
			owner,
			"domain",
			"sending",
			"cloudflare",
			false,
			cf.client,
		),
	).rejects.toBeInstanceOf(MxConflictError);
	expect((await getDomain(owner, "domain")).sending_provider).toBe(
		"cloudflare",
	);
	expect(cf.records.some((record) => record.content === "mx.old.example")).toBe(
		true,
	);
	await addDomain(
		owner,
		{ hostname: "example.com", replaceMxRecords: true },
		cf.client,
		cf.lookup,
	);
	expect(cf.records.some((record) => record.content === "mx.old.example")).toBe(
		false,
	);
});
test("legacy per-address Mailflare routes migrate, unrelated routes stay intact, and rollback restores every rule", async () => {
	const cf = cloudflareFixture();
	const own = {
		id: "old",
		enabled: true,
		priority: 7,
		name: "Original",
		actions: [{ type: "worker" as const, value: ["mailflare"] }],
		matchers: [
			{
				type: "literal" as const,
				field: "to" as const,
				value: "hello@example.com",
			},
		],
	};
	cf.rules.push(
		own,
		{
			...own,
			id: "other-worker",
			actions: [{ type: "worker", value: ["another-worker"] }],
		},
		{
			...own,
			id: "other-domain",
			matchers: [
				{ type: "literal", field: "to", value: "hello@elsewhere.example" },
			],
		},
	);
	await addDomain(owner, { hostname: "example.com" }, cf.client, cf.lookup);
	expect(cf.rules.find((rule) => rule.id === "old")).toMatchObject({
		enabled: true,
		priority: 7,
		actions: [{ type: "worker", value: ["mailrun-relay"] }],
	});
	expect(
		cf.rules.find((rule) => rule.id === "other-worker")?.actions?.[0]?.value,
	).toEqual(["another-worker"]);
	expect(
		cf.rules.find((rule) => rule.id === "other-domain")?.actions?.[0]?.value,
	).toEqual(["mailflare"]);
	const failed = cloudflareFixture();
	failed.rules.push(own);
	state.db.exec(
		"CREATE TRIGGER fixture_domain_failure BEFORE INSERT ON domains BEGIN SELECT RAISE(ABORT,'fixture save failed'); END",
	);
	await expect(
		addDomain(owner, { hostname: "example.com" }, failed.client, failed.lookup),
	).rejects.toThrow("fixture save failed");
	expect(failed.rules.find((rule) => rule.id === "old")).toMatchObject(own);
	expect(failed.routing.get("zone")).toBe(false);
	expect(failed.identities).toHaveLength(0);
});
test("rule pagination migrates addresses beyond the first provider page", async () => {
	const cf = cloudflareFixture();
	for (let index = 0; index < 61; index++)
		cf.rules.push({
			id: "rule-" + index,
			enabled: true,
			actions: [{ type: "worker", value: ["mailflare"] }],
			matchers: [
				{ type: "literal", field: "to", value: `user${index}@example.com` },
			],
		});
	await provisionCloudflareDomain(cf.client, "example.com");
	expect(
		cf.rules.every((rule) => rule.actions?.[0]?.value?.[0] === "mailrun-relay"),
	).toBe(true);
	expect(cf.calls.some((call) => call.path.includes("page=2"))).toBe(true);
});
test("same-zone leases exclude overlap and a restarted server can clear only domain operations", async () => {
	await domainOperation("zone", async () => {
		await expect(domainOperation("zone", async () => {})).rejects.toMatchObject(
			{ status: 409 },
		);
		await clearDomainRuntimeLeases();
	});
	await domainOperation("zone", async () => {});
});
test("Cloudflare cleanup retains other domains, foreign MX and unrelated forwarding rules", async () => {
	const cf = cloudflareFixture();
	await addDomain(owner, { hostname: "example.com" }, cf.client, cf.lookup);
	cf.rules.push({
		id: "external",
		enabled: true,
		actions: [{ type: "forward", value: ["external@example.net"] }],
		matchers: [{ type: "literal", field: "to", value: "external@example.com" }],
	});
	cf.addRecord({
		type: "MX",
		name: "example.com",
		content: "external.mx.example",
		priority: 20,
	});
	await chooseDomainProvider(
		owner,
		"domain",
		"receiving",
		"none",
		false,
		cf.client,
	);
	await removeCloudflareProvider(owner, "domain", "receiving", cf.client);
	expect(cf.rules.some((rule) => rule.id === "external")).toBe(true);
	expect(
		cf.records.some((record) => record.content === "external.mx.example"),
	).toBe(true);
	expect(cf.routing.get("zone")).toBe(true);
	expect((await getDomain(owner, "domain")).routing_enabled).toBe(0);
});
test("cleanup cannot remove the active provider or a wildcard identity that covers other hosts", async () => {
	const cf = cloudflareFixture();
	await expect(
		removeCloudflareProvider(owner, "domain", "sending", cf.client),
	).rejects.toMatchObject({ status: 400 });
	await chooseDomainProvider(
		owner,
		"domain",
		"sending",
		"none",
		false,
		cf.client,
	);
	await removeCloudflareProvider(owner, "domain", "sending", cf.client);
	expect((await getDomain(owner, "domain")).sending_enabled).toBe(0);
	const child = await addDomain(
		owner,
		{
			hostname: "mail.example.com",
			receivingProvider: "none",
			sendingProvider: "none",
		},
		cf.client,
		cf.lookup,
	);
	cf.identities.push({ tag: "wild", name: "*.example.com", enabled: true });
	await expect(
		removeCloudflareProvider(owner, child.domain.id, "sending", cf.client),
	).rejects.toMatchObject({ status: 409 });
	expect(cf.identities.some((row) => row.tag === "wild")).toBe(true);
});

test("the domain REST contract returns DNS summaries, validation errors and consent conflicts", async () => {
	const { domainsApi } = await import("../src/server/api/domains");
	const cf = cloudflareFixture();
	const call = async (
		path: string,
		method = "GET",
		body?: unknown,
		user = owner,
	) => {
		const response = await domainsApi(
			new Request("http://localhost/api/domains" + path, {
				method,
				...(body === undefined
					? {}
					: {
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify(body),
						}),
			}),
			user,
			cf.client,
			cf.lookup,
		);
		if (!response) throw new Error("Missing API response");
		return response;
	};
	expect(
		(await call("", "POST", { hostname: "example.com" }, stranger)).status,
	).toBe(403);
	expect(
		(await call("/domain/dns/setup", "POST", { record: "unknown" })).status,
	).toBe(400);
	cf.addRecord({
		type: "MX",
		name: "example.com",
		content: "previous.mx.example",
		priority: 20,
	});
	const conflict = await call("", "POST", { hostname: "example.com" });
	expect(conflict.status).toBe(409);
	expect(await conflict.json()).toMatchObject({
		code: "MX_RECORDS_CONFLICT",
		records: [{ content: "previous.mx.example", priority: 20 }],
	});
	const receiving = await call("/domain/receiving/cloudflare", "POST", {});
	expect(receiving.status).toBe(409);
	expect(await receiving.json()).toMatchObject({ code: "MX_CONFLICT" });
	expect(
		(
			await call("", "POST", {
				hostname: "example.com",
				replaceMxRecords: true,
			})
		).status,
	).toBe(200);
	expect(await (await call("?includeDns=true")).json()).toMatchObject({
		domains: [{ id: "domain", sendingProvider: "cloudflare" }],
		dns: { domain: { auth: { dkim: "ok" } } },
	});
	const privateData = JSON.stringify(await (await call("/domain/dns")).json());
	expect(privateData).not.toContain(cf.access.apiToken);
});

test("an unverified relay blocks receiving while domain metadata and read-only DNS management stay available", async () => {
	const cf = cloudflareFixture(),
		unverified = new DomainCloudflare(
			{ ...cf.access, workerName: null },
			cf.fetch,
		);
	await expect(
		setupDomainDns(owner, "domain", "mx", false, unverified, cf.lookup),
	).rejects.toThrow();
	expect(cf.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
});
