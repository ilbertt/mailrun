import { beforeEach, afterEach, expect, test } from "bun:test";
import { fixture, owner, stranger } from "./fixtures";
import { cloudflareFixture } from "./cloudflare-fixture";
import {
	DomainCloudflare,
	cloudflareAccess,
} from "../src/server/domains/cloudflare";
import {
	domainDnsDetails,
	setupCloudflareReceiving,
	setupDomainDns,
} from "../src/server/domains/service";
import { getInstallation } from "../src/server/cloudflare/installation";
import { deployEmailRelay, refreshRelay } from "../src/server/cloudflare/setup";
import { z } from "zod";
import type { CloudflareFetch } from "../src/server/cloudflare/client";

let state: Awaited<ReturnType<typeof fixture>>;
const envKeys = ["APP_URL", "CF_TOKEN", "CF_ACCOUNT_ID"] as const;
let environment: [(typeof envKeys)[number], string | undefined][];
beforeEach(async () => {
	state = await fixture();
	environment = envKeys.map((key) => [key, process.env[key]]);
	Object.assign(process.env, {
		APP_URL: "https://import.fixture.example",
		CF_TOKEN: "test-cloudflare-token",
		CF_ACCOUNT_ID: "a".repeat(32),
	});
	state.db.exec(
		"UPDATE domains SET routing_enabled=1,sending_requested=1,sending_enabled=1",
	);
});
afterEach(async () => {
	for (const [key, value] of environment) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await state.close();
});
function provider(
	onHealth?: () => Promise<void> | void,
	onUpload?: () => Promise<void>,
) {
	const cf = cloudflareFixture();
	cf.access.workerName = null;
	cf.access.accountId = "a".repeat(32);
	cf.access.apiToken = "test-cloudflare-token";
	cf.zones[0]!.account.id = cf.access.accountId;
	cf.routing.set("zone", true);
	cf.catchAlls.set("zone", {
		enabled: true,
		actions: [{ type: "worker", value: ["mailflare"] }],
		matchers: [{ type: "all" }],
	});
	const calls: { path: string; method: string }[] = [];
	let uploads = 0,
		secret = "";
	const send: CloudflareFetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		calls.push({ path: url.pathname, method: init?.method ?? "GET" });
		if (url.origin === process.env.APP_URL) {
			await onHealth?.();
			return Response.json({ ok: true });
		}
		if (url.hostname.endsWith(".workers.dev")) {
			expect(new Headers(init?.headers).get("Authorization")).toBe(
				"Bearer " + secret,
			);
			return Response.json({ ok: true });
		}
		expect(new Headers(init?.headers).get("Authorization")).toBe(
			"Bearer test-cloudflare-token",
		);
		if (url.pathname.endsWith("/workers/subdomain"))
			return Response.json({ success: true, result: { subdomain: "fixture" } });
		if (url.pathname.includes("/workers/scripts/")) {
			if (init?.method === "PUT") {
				if (!(init.body instanceof FormData))
					throw new Error("Missing Worker module");
				const metadata = z
					.object({
						bindings: z.array(z.object({ name: z.string(), text: z.string() })),
					})
					.parse(JSON.parse(String(init.body.get("metadata"))));
				secret =
					metadata.bindings.find((row) => row.name === "RELAY_SECRET")?.text ??
					"";
				uploads++;
				await onUpload?.();
			}
			return Response.json({ success: true, result: {} });
		}
		return cf.fetch(input, init);
	};
	return {
		cf,
		calls,
		send,
		client: new DomainCloudflare(cf.access, send),
		get uploads() {
			return uploads;
		},
	};
}
async function currentClient(p: ReturnType<typeof provider>) {
	const access = await cloudflareAccess();
	if (!access) throw new Error("Missing installed credentials");
	return new DomainCloudflare(access, p.send);
}

test("an imported active domain stays unbound on read and connects through its original receiving action without replacing mail data", async () => {
	const p = provider();
	p.cf.rules.push({
		id: "old-address",
		enabled: true,
		actions: [{ type: "worker", value: ["mailflare"] }],
		matchers: [{ type: "literal", field: "to", value: "hello@example.com" }],
	});
	p.cf.rules.push({
		id: "unrelated",
		enabled: true,
		actions: [{ type: "worker", value: ["another-service"] }],
		matchers: [{ type: "literal", field: "to", value: "other@example.com" }],
	});
	const before = ["users", "mailboxes", "messages"].map((table) =>
		JSON.stringify(state.db.query(`SELECT * FROM ${table}`).all()),
	);
	const view = await domainDnsDetails(owner, "domain", p.client, p.cf.lookup);
	expect(view.domain.routingEnabled).toBe(true);
	expect(view.dns.routing.relayReady).toBe(false);
	expect(await getInstallation()).toBeNull();
	expect(p.calls.every((call) => call.method === "GET")).toBe(true);
	await setupCloudflareReceiving(owner, "domain", false, p.client);
	const installed = await getInstallation();
	expect(installed?.worker_name).toBeTruthy();
	expect(p.uploads).toBe(1);
	expect(p.cf.catchAlls.get("zone")?.actions?.[0]?.value).toEqual([
		installed!.worker_name,
	]);
	expect(p.cf.rules[0]?.actions?.[0]?.value).toEqual([installed!.worker_name]);
	expect(p.cf.rules[1]?.actions?.[0]?.value).toEqual(["another-service"]);
	expect(
		(
			await domainDnsDetails(
				owner,
				"domain",
				await currentClient(p),
				p.cf.lookup,
			)
		).dns.routing.relayReady,
	).toBe(true);
	expect(
		["users", "mailboxes", "messages"].map((table) =>
			JSON.stringify(state.db.query(`SELECT * FROM ${table}`).all()),
		),
	).toEqual(before);
	expect(
		state.db
			.query("SELECT sending_enabled,sending_requested FROM domains")
			.get(),
	).toEqual({ sending_enabled: 1, sending_requested: 1 });
});

test("each imported hostname needs its own routing migration even when its zone already uses the shared native Worker", async () => {
	const p = provider();
	await setupCloudflareReceiving(owner, "domain", false, p.client);
	state.db.exec(
		"INSERT INTO domains(id,user_id,hostname,zone_id,status,routing_enabled,created_at) VALUES('child','owner','sub.example.com','zone','active',1,1)",
	);
	p.cf.rules.push({
		id: "child-address",
		enabled: true,
		actions: [{ type: "worker", value: ["mailflare"] }],
		matchers: [
			{ type: "literal", field: "to", value: "hello@sub.example.com" },
		],
	});
	const api = await currentClient(p);
	expect(
		(await domainDnsDetails(owner, "child", api, p.cf.lookup)).dns.routing
			.relayReady,
	).toBe(false);
	await setupCloudflareReceiving(owner, "child", false, api);
	expect(p.uploads).toBe(1);
	expect(p.cf.rules[0]?.actions?.[0]?.value).toEqual([
		(await getInstallation())!.worker_name,
	]);
	expect(
		(await domainDnsDetails(owner, "child", api, p.cf.lookup)).dns.routing
			.relayReady,
	).toBe(true);
});

test("foreign MX consent and current ownership are checked before publishing an imported installation's Worker", async () => {
	const p = provider();
	p.cf.addRecord({
		type: "MX",
		name: "example.com",
		content: "previous.example.net",
		priority: 5,
	});
	await expect(
		setupCloudflareReceiving(owner, "domain", false, p.client),
	).rejects.toMatchObject({ code: "MX_CONFLICT" });
	expect(p.uploads).toBe(0);
	expect(await getInstallation()).toBeNull();
	await expect(
		setupCloudflareReceiving(stranger, "domain", true, p.client),
	).rejects.toMatchObject({ status: 403 });
	state.db.exec(
		"UPDATE users SET is_primary_admin=0,can_manage_domains=1 WHERE id='owner'",
	);
	await expect(
		setupCloudflareReceiving(owner, "domain", true, p.client),
	).rejects.toMatchObject({ status: 403 });
	expect(p.calls.filter((call) => call.method !== "GET")).toEqual([]);
	expect(
		p.cf.records.some((record) => record.content === "previous.example.net"),
	).toBe(true);
});

test("MX DNS repair installs the relay and returns the newly committed binding in the same response", async () => {
	const p = provider();
	const result = await setupDomainDns(
		owner,
		"domain",
		"mx",
		false,
		p.client,
		p.cf.lookup,
	);
	expect(result.dns.routing.relayReady).toBe(true);
	expect(p.uploads).toBe(1);
});

test("revoking primary-administrator status during a health probe prevents Worker publication", async () => {
	const p = provider(() => {
		state.db.exec(
			"UPDATE users SET is_primary_admin=0,can_manage_domains=1 WHERE id='owner'",
		);
	});
	await expect(
		setupCloudflareReceiving(owner, "domain", false, p.client),
	).rejects.toMatchObject({ status: 403 });
	expect(p.uploads).toBe(0);
	expect(
		p.calls.filter(
			(call) =>
				call.method !== "GET" && !call.path.endsWith("/api/relay-health"),
		),
	).toEqual([]);
	expect(
		state.db.query("SELECT mailrun_relay_worker_name FROM domains").get(),
	).toEqual({ mailrun_relay_worker_name: null });
});

test("deploy and refresh operations share a fenced installation lease", async () => {
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const p = provider(undefined, async () => {
		entered.resolve();
		await release.promise;
	});
	const deployment = deployEmailRelay(
		owner,
		{
			hostname: "example.com",
			accountId: "a".repeat(32),
			apiToken: "test-cloudflare-token",
		},
		p.send,
	);
	try {
		await entered.promise;
		await expect(refreshRelay(owner, p.send)).rejects.toMatchObject({
			status: 409,
		});
		expect(p.uploads).toBe(1);
	} finally {
		release.resolve();
		await deployment;
	}
	expect(state.db.query("SELECT name FROM mailrun_job_leases").all()).toEqual(
		[],
	);
});

test("a failed first relay publication can be retried from a different owned domain using the same Worker and secret", async () => {
	let failing = true;
	const p = provider(undefined, async () => {
		if (failing) throw new Error("temporary publication failure");
	});
	const input = {
		hostname: "example.com",
		accountId: "a".repeat(32),
		apiToken: "test-cloudflare-token",
	};
	await expect(deployEmailRelay(owner, input, p.send)).rejects.toThrow(
		"temporary publication failure",
	);
	const before = await getInstallation();
	p.cf.zones.push({
		id: "another-zone",
		name: "another.example",
		account: { id: "a".repeat(32) },
	});
	failing = false;
	await deployEmailRelay(
		owner,
		{ ...input, hostname: "another.example" },
		p.send,
	);
	const after = await getInstallation();
	expect(after).toMatchObject({
		hostname: "another.example",
		zone_id: "another-zone",
		worker_name: before!.worker_name,
		relay_secret: before!.relay_secret,
		phase: "deployed",
	});
	expect(
		new Set(
			p.calls
				.filter(
					(call) =>
						call.method === "PUT" &&
						/\/workers\/scripts\/[^/]+$/.test(call.path),
				)
				.map((call) => call.path),
		).size,
	).toBe(1);
});

test("namespace creation rechecks primary permissions after discovering a missing workers.dev namespace", async () => {
	const p = provider(),
		writes: string[] = [];
	const send: CloudflareFetch = async (input, init) => {
		const url = new URL(String(input));
		if (
			url.pathname.endsWith("/workers/subdomain") &&
			(!init?.method || init.method === "GET")
		) {
			state.db.exec(
				"UPDATE users SET is_primary_admin=0,can_manage_domains=1 WHERE id='owner'",
			);
			return Response.json(
				{
					success: false,
					errors: [{ code: 1000, message: "Namespace missing" }],
				},
				{ status: 404 },
			);
		}
		if (
			url.hostname === "api.cloudflare.com" &&
			init?.method &&
			init.method !== "GET"
		)
			writes.push(url.pathname);
		return p.send(input, init);
	};
	await expect(
		deployEmailRelay(
			owner,
			{
				hostname: "example.com",
				accountId: "a".repeat(32),
				apiToken: "test-cloudflare-token",
			},
			send,
		),
	).rejects.toMatchObject({ status: 403 });
	expect(writes).toEqual([]);
	expect(p.uploads).toBe(0);
});
