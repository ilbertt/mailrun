import { afterEach, beforeEach, expect, test } from "bun:test";
import { z } from "zod";
import { cloudflareCredentials } from "../src/server/cloudflare/credentials";
import { cloudflare } from "../src/server/cloudflare/client";

const keys = ["CF_TOKEN", "CF_API_KEY", "CF_EMAIL", "CF_ACCOUNT_ID"] as const;
let previous: Record<string, string | undefined>;
beforeEach(() => {
	previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
});
afterEach(() => {
	for (const key of keys) {
		if (previous[key] === undefined) delete process.env[key];
		else process.env[key] = previous[key];
	}
});

test("source global-key precedence, whitespace, partial pairs and saved fallback retain one credential scheme", () => {
	const saved = { api_token: "saved-token", account_id: "bound-account" };
	Object.assign(process.env, {
		CF_TOKEN: " environment-token ",
		CF_API_KEY: " environment-key ",
		CF_EMAIL: " owner@example.com ",
		CF_ACCOUNT_ID: "another-account",
	});
	expect(cloudflareCredentials(saved)).toEqual({
		auth: {
			kind: "global-key",
			key: "environment-key",
			email: "owner@example.com",
		},
		accountId: "bound-account",
	});
	delete process.env.CF_EMAIL;
	expect(cloudflareCredentials(saved).auth).toEqual({
		kind: "token",
		token: "environment-token",
	});
	delete process.env.CF_TOKEN;
	expect(cloudflareCredentials(saved).auth).toBeNull();
	delete process.env.CF_API_KEY;
	expect(cloudflareCredentials(saved).auth).toEqual({
		kind: "token",
		token: "saved-token",
	});
	const globalSaved = {
		...saved,
		api_token: "",
		api_key: "saved-key",
		api_email: "saved@example.com",
	};
	expect(cloudflareCredentials(globalSaved).auth).toEqual({
		kind: "global-key",
		key: "saved-key",
		email: "saved@example.com",
	});
	process.env.CF_TOKEN = "replacement-token";
	expect(cloudflareCredentials(globalSaved).auth).toEqual({
		kind: "token",
		token: "replacement-token",
	});
});

test("Cloudflare requests carry exactly the chosen scheme and keep multipart boundary generation intact", async () => {
	for (const auth of [
		{ kind: "token", token: "chosen-token" },
		{ kind: "global-key", key: "chosen-key", email: "chosen@example.com" },
	] as const) {
		const body = new FormData();
		body.set("metadata", "{}");
		await cloudflare(
			auth,
			"/accounts/fixture/workers/scripts/relay",
			z.object({ ok: z.literal(true) }),
			{
				method: "PUT",
				body,
				headers: {
					Authorization: "Bearer unwanted",
					"X-Auth-Key": "unwanted",
					"X-Auth-Email": "unwanted@example.com",
					"X-Request-Fixture": "retained",
				},
			},
			async (url, init) => {
				const request = new Request(url, init),
					headers = request.headers;
				expect(headers.get("X-Request-Fixture")).toBe("retained");
				if (auth.kind === "global-key") {
					expect(headers.get("Authorization")).toBeNull();
					expect(headers.get("X-Auth-Key")).toBe(auth.key);
					expect(headers.get("X-Auth-Email")).toBe(auth.email);
				} else {
					expect(headers.get("Authorization")).toBe("Bearer " + auth.token);
					expect(headers.get("X-Auth-Key")).toBeNull();
					expect(headers.get("X-Auth-Email")).toBeNull();
				}
				expect(headers.get("Content-Type")).toStartWith(
					"multipart/form-data; boundary=",
				);
				expect((await request.formData()).get("metadata")).toBe("{}");
				return Response.json({ success: true, result: { ok: true } });
			},
		);
	}
});
