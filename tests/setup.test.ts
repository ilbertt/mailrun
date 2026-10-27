import { test, expect } from "bun:test";
import { fixture, owner, stranger } from "./fixtures";
import { provisionEmail, refreshRelay } from "../src/server/cloudflare/setup";
import { getInstallation } from "../src/server/cloudflare/installation";
import { verifyRelay } from "../src/shared/relay-signature";
import type { CloudflareFetch } from "../src/server/cloudflare/client";

test("setup deploys the relay before routing and retry reuses its name and secret", async () => {
	const state = await fixture();
	const oldOrigin = process.env.APP_URL;
	process.env.APP_URL = "https://mail.example.com";
	const calls: string[] = [];
	let healthy = false;
	let publicHealthy = true;
	const request: CloudflareFetch = async (input, init) => {
		const url = String(input);
		calls.push(`${init?.method ?? "GET"} ${url}`);
		if (url.endsWith("/api/relay-health")) {
			const saved = await getInstallation(),
				headers = new Headers(init?.headers);
			expect(saved).not.toBeNull();
			expect(
				await verifyRelay(
					saved!.relay_secret,
					headers.get("x-mailrun-timestamp") ?? "",
					"",
					"",
					new Uint8Array(),
					headers.get("x-mailrun-signature") ?? "",
				),
			).toBe(true);
			return new Response(publicHealthy ? '{"ok":true}' : "Unavailable", {
				status: publicHealthy ? 200 : 503,
			});
		}
		if (url.includes("workers.dev"))
			return new Response(healthy ? '{"ok":true}' : "Unavailable", {
				status: healthy ? 200 : 503,
			});
		let result: unknown = {};
		if (url.includes("/zones?"))
			result = [
				{ id: "zone", name: "example.com", account: { id: "a".repeat(32) } },
			];
		else if (url.endsWith("/workers/subdomain"))
			result = { subdomain: "fixture" };
		else if (url.endsWith("/email/routing/rules/catch_all"))
			result =
				init?.method === "PUT"
					? JSON.parse(String(init.body))
					: {
							enabled: false,
							actions: [{ type: "drop" }],
							matchers: [{ type: "all" }],
						};
		else if (
			url.includes("/email/routing/rules?") ||
			url.includes("/dns_records?")
		)
			result = [];
		else if (url.endsWith("/email/routing"))
			result = { enabled: false, status: "unconfigured" };
		else if (url.endsWith("/email/routing/dns"))
			result = { enabled: true, status: "ready" };
		else if (url.endsWith("/email/sending/subdomains"))
			result = [{ tag: "sending", name: "example.com", enabled: true }];
		return Response.json({ success: true, result });
	};
	const input = {
		accountId: "a".repeat(32),
		hostname: "example.com",
		apiToken: "test-cloudflare-token",
		localPart: "hello",
		activateRouting: true,
	};
	try {
		await expect(provisionEmail(stranger, input, request)).rejects.toThrow(
			"administrator",
		);
		expect(calls).toEqual([]);
		await expect(provisionEmail(owner, input, request)).rejects.toThrow(
			"could not reach",
		);
		expect(calls.some((call) => call.includes("/email/routing/"))).toBe(false);
		const before = await getInstallation();
		healthy = true;
		expect((await provisionEmail(owner, input, request))?.phase).toBe("ready");
		const after = await getInstallation();
		expect(after?.worker_name).toBe(before?.worker_name);
		expect(after?.relay_secret).toBe(before?.relay_secret);
		expect(
			calls.some((call) => /\/(?:r2|queues|schedules|d1)(?:\/|$)/.test(call)),
		).toBe(false);
		expect(state.db.query("SELECT id FROM mailboxes").all()).toHaveLength(1);
		state.db.exec(
			"UPDATE mailrun_installation SET relay_version='previous-version'",
		);
		calls.length = 0;
		publicHealthy = false;
		await expect(refreshRelay(owner, request)).rejects.toThrow(
			"could not reach",
		);
		expect(
			calls.some(
				(call) => call.startsWith("PUT ") && call.includes("/workers/scripts/"),
			),
		).toBe(false);
		publicHealthy = true;
		calls.length = 0;
		healthy = false;
		await expect(refreshRelay(owner, request)).rejects.toThrow(
			"could not reach",
		);
		expect((await getInstallation())?.relay_version).toBe("previous-version");
		healthy = true;
		await refreshRelay(owner, request);
		expect((await getInstallation())?.relay_version).not.toBe(
			"previous-version",
		);
		expect(
			calls.some(
				(call) =>
					call.includes("/email/routing/") || call.includes("/email/sending/"),
			),
		).toBe(false);
	} finally {
		if (oldOrigin === undefined) delete process.env.APP_URL;
		else process.env.APP_URL = oldOrigin;
		await state.close();
	}
});

test("setup creates a missing workers.dev subdomain and migrates existing Mailflare addresses only after health checks", async () => {
	const { cloudflareFixture } = await import("./cloudflare-fixture");
	const cf = cloudflareFixture(),
		state = await fixture(),
		oldOrigin = process.env.APP_URL;
	process.env.APP_URL = "https://mail.example.com";
	const accountId = "a".repeat(32);
	cf.zones[0]!.account.id = accountId;
	cf.rules.push({
		id: "legacy",
		enabled: true,
		actions: [{ type: "worker", value: ["mailflare"] }],
		matchers: [{ type: "literal", field: "to", value: "hello@example.com" }],
	});
	let subdomain: string | null = null;
	const calls: { method: string; path: string }[] = [];
	const request: CloudflareFetch = async (input, init) => {
		const url = new URL(String(input)),
			method = init?.method ?? "GET";
		calls.push({ method, path: url.pathname });
		if (
			url.pathname === "/api/relay-health" ||
			url.hostname.endsWith("workers.dev")
		)
			return Response.json({ ok: true });
		if (url.pathname.endsWith("/workers/subdomain")) {
			if (method === "GET" && !subdomain)
				return Response.json(
					{
						success: false,
						errors: [{ code: 1000, message: "Not registered" }],
					},
					{ status: 404 },
				);
			if (method === "PUT")
				subdomain = JSON.parse(String(init?.body)).subdomain;
			return Response.json({ success: true, result: { subdomain } });
		}
		if (url.pathname.includes("/workers/scripts/"))
			return Response.json({ success: true, result: {} });
		return cf.fetch(input, init);
	};
	try {
		expect(
			(
				await provisionEmail(
					owner,
					{
						accountId,
						hostname: "example.com",
						apiToken: "test-cloudflare-token",
						localPart: "hello",
						activateRouting: true,
					},
					request,
				)
			)?.phase,
		).toBe("ready");
		const installation = await getInstallation();
		expect(cf.rules[0]?.actions?.[0]?.value).toEqual([
			installation!.worker_name,
		]);
		expect(String(subdomain)).toBe("mailrun-" + accountId);
		expect(
			calls.findIndex((call) => call.path === "/api/relay-health"),
		).toBeLessThan(
			calls.findIndex(
				(call) =>
					call.method === "PUT" && call.path.includes("/workers/scripts/"),
			),
		);
		expect(
			calls.findIndex((call) => call.path.includes("/email/routing/")),
		).toBeGreaterThan(
			calls.findIndex(
				(call) =>
					call.method === "PUT" && call.path.includes("/workers/scripts/"),
			),
		);
	} finally {
		if (oldOrigin === undefined) delete process.env.APP_URL;
		else process.env.APP_URL = oldOrigin;
		await state.close();
	}
});
