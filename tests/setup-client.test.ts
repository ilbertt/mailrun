import { expect, test } from "bun:test";
import {
	prepareSetup,
	submitRegistration,
} from "../src/app/(auth)/register/utils";
import { waitForRelayHealth } from "../src/server/cloudflare/setup";

test("setup preserves an HTTP failure when the gateway returns HTML", async () => {
	const previous = globalThis.fetch;
	globalThis.fetch = Object.assign(
		async () => new Response("<html>Bad gateway</html>", { status: 502 }),
		{ preconnect: previous.preconnect },
	);
	try {
		const result = await prepareSetup();
		expect(result.ok).toBe(false);
		expect(result.data.error).toBe(
			"Setup request failed (HTTP 502). Please try again.",
		);
	} finally {
		globalThis.fetch = previous;
	}
});

test("registration preserves provider errors even when an unfamiliar error code is present", async () => {
	const previous = globalThis.fetch;
	globalThis.fetch = Object.assign(
		async () =>
			Response.json(
				{ error: "Relay activation is pending", code: "PROVIDER_NOT_READY" },
				{ status: 502 },
			),
		{ preconnect: previous.preconnect },
	);
	try {
		const result = await submitRegistration(new FormData(), {
			firstRun: true,
			setupToken: "fixture",
			domain: "example.com",
		});
		expect(result.ok).toBe(false);
		expect(result.data.error).toBe("Relay activation is pending");
		expect(result.data.code).toBeUndefined();
	} finally {
		globalThis.fetch = previous;
	}
});

test("a malformed successful response cannot complete setup or be mistaken for a network failure", async () => {
	const previous = globalThis.fetch;
	globalThis.fetch = Object.assign(async () => new Response("not JSON"), {
		preconnect: previous.preconnect,
	});
	try {
		const result = await prepareSetup();
		expect(result.ok).toBe(false);
		expect(result.data.error).toBe(
			"Setup returned an unexpected response. Please try again.",
		);
	} finally {
		globalThis.fetch = previous;
	}
});

test("relay readiness retries a transient new-Worker failure and requires the signed JSON probe", async () => {
	let attempts = 0;
	await waitForRelayHealth(
		"https://fixture.workers.dev/health",
		"fixture-secret",
		async (input, init) => {
			expect(String(input)).toBe("https://fixture.workers.dev/health");
			expect(new Headers(init?.headers).get("Authorization")).toBe(
				"Bearer fixture-secret",
			);
			expect(init?.method ?? "GET").toBe("GET");
			attempts++;
			if (attempts === 1) return new Response("Not ready", { status: 404 });
			if (attempts === 2) return new Response("<html>Not the relay</html>");
			return Response.json({ ok: true });
		},
	);
	expect(attempts).toBe(3);
});

test("relay readiness does not retry rejected credentials", async () => {
	let attempts = 0;
	await expect(
		waitForRelayHealth(
			"https://fixture.workers.dev/health",
			"fixture-secret",
			async () => {
				attempts++;
				return new Response("Unauthorized", { status: 401 });
			},
		),
	).rejects.toThrow("HTTP 401");
	expect(attempts).toBe(1);
});
