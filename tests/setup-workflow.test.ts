import { beforeEach, afterEach, expect, test } from "bun:test";
import { fixture, owner, stranger } from "./fixtures";
import { cloudflareFixture } from "./cloudflare-fixture";
import { setupApi } from "../src/server/api/setup";
import {
	setupSnapshot,
	registerWorkspace,
	ensureSetupRelay,
} from "../src/server/setup/service";
import { getInstallation } from "../src/server/cloudflare/installation";
import { verifyRelay } from "../src/shared/relay-signature";
import { login, hasAdminAccount } from "../src/server/auth/service";
import type { CloudflareFetch } from "../src/server/cloudflare/client";
import { z } from "zod";
let state: Awaited<ReturnType<typeof fixture>>;
let restore: () => void;
const origin = "https://setup.fixture.example",
	setupToken = "test-installation-setup-token";
beforeEach(async () => {
	state = await fixture();
	state.db.exec("DELETE FROM users");
	const keys = [
		"APP_URL",
		"CF_TOKEN",
		"CF_API_KEY",
		"CF_EMAIL",
		"CF_ACCOUNT_ID",
		"SETUP_TOKEN",
		"TURNSTILE_SECRET_KEY",
	] as const;
	const previous = keys.map((key) => [key, process.env[key]] as const);
	restore = () => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
	Object.assign(process.env, {
		APP_URL: origin,
		CF_TOKEN: "test-cloudflare-token",
		CF_ACCOUNT_ID: "a".repeat(32),
		SETUP_TOKEN: setupToken,
	});
	delete process.env.TURNSTILE_SECRET_KEY;
	delete process.env.CF_API_KEY;
	delete process.env.CF_EMAIL;
	globalThis.__mailrunPublicAuthAttempts?.clear();
});
afterEach(async () => {
	restore();
	await state.close();
});
function provider() {
	const cf = cloudflareFixture();
	cf.access.accountId = "a".repeat(32);
	cf.access.auth = { kind: "token", token: "test-cloudflare-token" };
	cf.zones[0]!.account.id = cf.access.accountId;
	let healthy = true,
		uploads = 0;
	const calls: string[] = [];
	const send: CloudflareFetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		calls.push((init?.method ?? "GET") + " " + url.pathname);
		if (url.origin === origin) {
			const installation = await getInstallation(),
				headers = new Headers(init?.headers);
			expect(installation).not.toBeNull();
			expect(
				await verifyRelay(
					installation!.relay_secret,
					headers.get("X-Mailrun-Timestamp") ?? "",
					"",
					"",
					new Uint8Array(),
					headers.get("X-Mailrun-Signature") ?? "",
				),
			).toBe(true);
			return Response.json({ ok: true });
		}
		if (url.hostname.endsWith(".workers.dev"))
			return Response.json({ ok: healthy }, { status: healthy ? 200 : 503 });
		if (url.pathname.endsWith("/workers/subdomain"))
			return Response.json({ success: true, result: { subdomain: "fixture" } });
		if (url.pathname.includes("/workers/scripts/")) {
			if (init?.method === "PUT") {
				uploads++;
				if (!(init.body instanceof FormData))
					throw new Error("Worker upload must be multipart");
				const metadata = z
					.object({
						bindings: z.array(z.object({ name: z.string(), text: z.string() })),
					})
					.parse(JSON.parse(String(init.body.get("metadata"))));
				expect(
					metadata.bindings.find((row) => row.name === "MAILRUN_URL")?.text,
				).toBe(origin);
				expect(
					metadata.bindings.find((row) => row.name === "RELAY_SECRET")?.text,
				).toBe((await getInstallation())?.relay_secret);
				expect(await (init.body.get("relay.js") as File).text()).toContain(
					"email",
				);
			}
			return Response.json({ success: true, result: {} });
		}
		return cf.fetch(input, init);
	};
	return {
		cf,
		send,
		calls,
		get uploads() {
			return uploads;
		},
		setHealthy(value: boolean) {
			healthy = value;
		},
	};
}
const input = () => ({
	domain: "example.com",
	username: "ME",
	password: "eight123",
	resetEmail: "Recovery@example.org",
	setupToken,
	enableSending: false,
});
test("source Global API Key deployment completes first-account setup and keeps credentials out of public status", async () => {
	process.env.CF_API_KEY = " global-setup-key ";
	process.env.CF_EMAIL = " owner@example.com ";
	const p = provider();
	let apiCalls = 0;
	const send: CloudflareFetch = async (input, init) => {
		if (new URL(String(input)).origin === "https://api.cloudflare.com") {
			apiCalls++;
			const headers = new Headers(init?.headers);
			expect(headers.get("Authorization")).toBeNull();
			expect(headers.get("X-Auth-Key")).toBe("global-setup-key");
			expect(headers.get("X-Auth-Email")).toBe("owner@example.com");
		}
		return p.send(input, init);
	};
	const configured = await setupApi(request("/api/setup/prepare", {}));
	expect(configured?.status).toBe(200);
	expect(
		await registerWorkspace({ ...input(), enableSending: true }, send),
	).toEqual({ ok: true, redirect: "/login" });
	expect(apiCalls).toBeGreaterThan(10);
	expect(await getInstallation()).toMatchObject({
		api_token: "",
		api_key: "global-setup-key",
		api_email: "owner@example.com",
		phase: "ready",
	});
	const status = JSON.stringify(await setupSnapshot());
	expect(status).not.toContain("global-setup-key");
	expect(status).not.toContain("owner@example.com");
	expect(status).not.toContain(process.env.CF_TOKEN!);
});
function request(
	path: string,
	body?: unknown,
	token: string | null = setupToken,
	requestOrigin = origin,
) {
	return new Request(origin + path, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			Origin: requestOrigin,
			"Content-Type": "application/json",
			...(token ? { "X-Mailrun-Setup-Token": token } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}
test("original setup status/checks use real local storage and never disclose credentials", async () => {
	expect(await setupSnapshot()).toEqual({
		hasAdminAccount: false,
		hasPrimaryDomain: false,
		primaryDomain: null,
	});
	const result = await setupApi(request("/api/setup/prepare", {}));
	expect(result?.status).toBe(200);
	const body = z
		.object({
			checks: z.array(z.object({ key: z.string(), configured: z.boolean() })),
			migrated: z.boolean(),
		})
		.parse(await result!.json());
	expect(body.checks.every((row) => row.configured)).toBe(true);
	expect(body.checks.map((row) => row.key)).not.toContain("D1 database");
	expect(JSON.stringify(body)).not.toContain(process.env.CF_TOKEN!);
	delete process.env.CF_ACCOUNT_ID;
	expect((await setupApi(request("/api/setup/prepare", {})))?.status).toBe(503);
});
test("domain and MX preflights require the setup token and same-origin requests before any provider access", async () => {
	const p = provider();
	expect(
		(
			await setupApi(
				request("/api/setup/domain", { hostname: "example.com" }, null),
				undefined,
				p.send,
			)
		)?.status,
	).toBe(403);
	expect(
		(
			await setupApi(
				request(
					"/api/setup/domain",
					{ hostname: "example.com" },
					setupToken,
					"https://other.example",
				),
				undefined,
				p.send,
			)
		)?.status,
	).toBe(403);
	expect(p.calls).toEqual([]);
	const result = await setupApi(
		request("/api/setup/domain", { hostname: "Sub.EXAMPLE.COM." }),
		undefined,
		p.send,
	);
	expect(result?.status).toBe(200);
	expect(await result!.json()).toEqual({
		domain: {
			hostname: "sub.example.com",
			zone: { id: "zone", name: "example.com" },
		},
	});
	expect(p.cf.calls.every((row) => row.method === "GET")).toBe(true);
	expect(await setupSnapshot()).toMatchObject({ hasPrimaryDomain: false });
	p.cf.addRecord({
		type: "MX",
		name: "example.com",
		content: "old.mail.example",
		priority: 5,
	});
	const mx = await setupApi(
		request("/api/setup/domain/mx", { hostname: "example.com" }),
		undefined,
		p.send,
	);
	expect(await mx!.json()).toEqual({ hasExistingMx: true });
});
test("receive-only registration deploys/verifies the relay, creates the source account/mailbox and ends signed out", async () => {
	const p = provider(),
		result = await setupApi(
			request("/api/auth/register", input()),
			undefined,
			p.send,
		);
	expect(result?.status).toBe(200);
	expect(await result!.json()).toEqual({ ok: true, redirect: "/login" });
	expect(result?.headers.get("Set-Cookie")).toContain("Max-Age=0");
	expect(result?.headers.get("Cache-Control")).toBe("no-store");
	expect(
		state.db
			.query(
				"SELECT email,name,reset_email,role,is_primary_admin,booking_username FROM users",
			)
			.get(),
	).toMatchObject({
		email: "me@example.com",
		name: "me",
		reset_email: "recovery@example.org",
		role: "admin",
		is_primary_admin: 1,
		booking_username: "me",
	});
	expect(
		state.db.query("SELECT local_part,use_all_domains FROM mailboxes").get(),
	).toEqual({ local_part: "me", use_all_domains: 1 });
	expect(
		state.db
			.query(
				"SELECT routing_enabled,sending_requested,sending_provider FROM domains",
			)
			.get(),
	).toEqual({
		routing_enabled: 1,
		sending_requested: 0,
		sending_provider: "none",
	});
	expect(state.db.query("SELECT id FROM sessions").all()).toHaveLength(0);
	expect(p.cf.identities).toHaveLength(0);
	expect(p.uploads).toBe(1);
	const uploaded = p.calls.findIndex(
			(row) => row.startsWith("PUT ") && row.includes("/workers/scripts/"),
		),
		routed = p.calls.findIndex(
			(row) => row.endsWith("/email/routing/dns") && row.startsWith("POST "),
		);
	expect(uploaded).toBeGreaterThan(-1);
	expect(routed).toBeGreaterThan(uploaded);
	expect(
		p.calls.some((row) => /\/(r2|d1|queues|schedules)(\/|$)/.test(row)),
	).toBe(false);
	const signedIn = await login({
		email: "me@example.com",
		password: "eight123",
	});
	expect(signedIn.mfaRequired).toBe(false);
	expect((await setupApi(request("/api/setup/prepare", {})))?.status).toBe(403);
	expect(
		(await setupApi(request("/api/auth/register", input()), undefined, p.send))
			?.status,
	).toBe(403);
});
test("MX conflicts are confirmed before creating an account; sending preference is retained after consent", async () => {
	const p = provider();
	p.cf.addRecord({
		type: "MX",
		name: "example.com",
		content: "old.mail.example",
		priority: 5,
	});
	const denied = await setupApi(
		request("/api/auth/register", { ...input(), enableSending: true }),
		undefined,
		p.send,
	);
	expect(denied?.status).toBe(409);
	expect(await denied!.json()).toMatchObject({ code: "MX_RECORDS_CONFLICT" });
	expect(state.db.query("SELECT id FROM users").all()).toHaveLength(0);
	expect(p.uploads).toBe(0);
	const accepted = await setupApi(
		request("/api/auth/register", {
			...input(),
			enableSending: true,
			replaceMxRecords: true,
		}),
		undefined,
		p.send,
	);
	expect(accepted?.status).toBe(200);
	expect(p.cf.identities).toHaveLength(1);
	expect(
		state.db
			.query(
				"SELECT sending_requested,sending_enabled,sending_provider FROM domains",
			)
			.get(),
	).toEqual({
		sending_requested: 1,
		sending_enabled: 1,
		sending_provider: "cloudflare",
	});
});
test("failed Worker verification removes the partial account and retry reuses its Worker identity and secret", async () => {
	const p = provider();
	p.setHealthy(false);
	await expect(registerWorkspace(input(), p.send)).rejects.toThrow(
		"could not reach",
	);
	expect(await hasAdminAccount()).toBe(false);
	expect(state.db.query("SELECT id FROM domains").all()).toHaveLength(0);
	expect(p.cf.calls.some((row) => row.method !== "GET")).toBe(false);
	const before = await getInstallation();
	p.setHealthy(true);
	expect(await registerWorkspace(input(), p.send)).toEqual({
		ok: true,
		redirect: "/login",
	});
	const after = await getInstallation();
	expect(after?.worker_name).toBe(before?.worker_name);
	expect(after?.relay_secret).toBe(before?.relay_secret);
});
test("initial registration is serialized, and header-only setup authentication works", async () => {
	const p = provider(),
		{ setupToken: ignored, ...body } = input();
	const [one, two] = await Promise.all([
		setupApi(request("/api/auth/register", body), undefined, p.send),
		setupApi(
			request("/api/auth/register", { ...body, username: "other" }),
			undefined,
			p.send,
		),
	]);
	expect([one?.status, two?.status].sort()).toEqual([200, 409]);
	expect(
		state.db.query("SELECT id FROM users WHERE role='admin'").all(),
	).toHaveLength(1);
	expect(p.uploads).toBe(1);
});
test("authenticated onboarding deploys only the relay before its separate domain and mailbox steps", async () => {
	const p = provider();
	state.db
		.query(
			"INSERT INTO users(id,email,name,password_hash,role,is_primary_admin,created_at) VALUES(?,?,?,?,?,?,1)",
		)
		.run(owner.id, owner.email, owner.name, "test-only", "admin", 1);
	await ensureSetupRelay(owner, "example.com", p.send);
	expect(p.uploads).toBe(1);
	expect(state.db.query("SELECT id FROM domains").all()).toHaveLength(0);
	expect(state.db.query("SELECT id FROM mailboxes").all()).toHaveLength(0);
	await ensureSetupRelay(owner, "example.com", p.send);
	expect(p.uploads).toBe(1);
	await expect(
		ensureSetupRelay(stranger, "example.com", p.send),
	).rejects.toMatchObject({ status: 401 });
});
test("a workspace containing plain users can still claim its first administrator", async () => {
	const p = provider();
	state.db
		.query(
			"INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES('legacy','legacy@example.org','Legacy','test-only','user',1)",
		)
		.run();
	expect(await hasAdminAccount()).toBe(false);
	await registerWorkspace(input(), p.send);
	expect(await hasAdminAccount()).toBe(true);
	expect(state.db.query("SELECT id FROM users").all()).toHaveLength(2);
});

test("failure after routing starts restores foreign MX and removes the partial account/domain", async () => {
	const p = provider();
	p.cf.addRecord({
		type: "MX",
		name: "example.com",
		content: "old.mail.example",
		priority: 5,
	});
	const send: CloudflareFetch = async (input, init) => {
		if (
			String(input).endsWith("/email/sending/subdomains") &&
			init?.method === "POST"
		)
			return Response.json(
				{
					success: false,
					errors: [{ code: 1000, message: "Sending capability denied" }],
				},
				{ status: 403 },
			);
		return p.send(input, init);
	};
	const failed = await setupApi(
		request("/api/auth/register", {
			...input(),
			enableSending: true,
			replaceMxRecords: true,
		}),
		undefined,
		send,
	);
	expect(failed?.status).toBe(502);
	expect(await failed!.json()).toEqual({ error: "Sending capability denied" });
	expect(state.db.query("SELECT id FROM users").all()).toHaveLength(0);
	expect(state.db.query("SELECT id FROM domains").all()).toHaveLength(0);
	expect(
		p.cf.records.some(
			(row) => row.type === "MX" && row.content === "old.mail.example",
		),
	).toBe(true);
	expect(p.cf.routing.get("zone")).toBe(false);
	expect(p.cf.catchAlls.get("zone")?.enabled).toBe(false);
	expect((await getInstallation())?.phase).toBe("deployed");
});
