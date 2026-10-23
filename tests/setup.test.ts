import { test, expect } from "bun:test";
import { fixture, owner, stranger } from "./fixtures";
import { provisionEmail, refreshRelay } from "../src/server/cloudflare/setup";
import { getInstallation } from "../src/server/cloudflare/installation";
import type { CloudflareFetch } from "../src/server/cloudflare/client";

test("setup deploys the relay before routing and retry reuses its name and secret", async () => {
	const state = await fixture();
	const oldOrigin = process.env.APP_URL;
	process.env.APP_URL = "https://mail.example.com";
	const calls: string[] = [];
	let healthy = false;
	const request: CloudflareFetch = async (input, init) => {
		const url = String(input);
		calls.push(`${init?.method ?? "GET"} ${url}`);
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
