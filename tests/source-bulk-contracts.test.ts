import { test, expect, beforeEach, afterEach } from "bun:test";
import { fixture, owner, stranger } from "./fixtures";
import { dispatchMailApi } from "../src/server/api/mail";
import { apiErrorResponse } from "../src/server/api/errors";
import {
	bulkSamples,
	bulkPath,
	bulkPayload,
	prepareBulkFixture,
	bulkSnapshot,
} from "./bulk-contract-fixture";
import capture from "./source-bulk-contracts.json";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
for (const sample of bulkSamples)
	test(`original bulk/folder contract: ${sample.name}`, async () => {
		const expected = capture.cases.find((value) => value.name === sample.name);
		if (!expected) throw new Error("Missing original capture: " + sample.name);
		await prepareBulkFixture(state.db, state.directory, sample);
		const started = Math.floor(Date.now() / 1000),
			body = sample.rawBody ?? JSON.stringify(bulkPayload(sample));
		expect(
			body ? new Bun.CryptoHasher("sha256").update(body).digest("hex") : null,
		).toBe(expected?.requestSha256 ?? null);
		const request = new Request("https://mail.example" + bulkPath(sample), {
			method: sample.method ?? "POST",
			headers: { "Content-Type": "application/json" },
			...(sample.method === "GET" ? {} : { body }),
		});
		let response: Response;
		try {
			response = await dispatchMailApi(
				request,
				sample.actor === "owner" ? owner : stranger,
			);
		} catch (error) {
			response = await apiErrorResponse(error);
		}
		expect(response.status).toBe(expected.status);
		const snapshot = await bulkSnapshot(
			state.db,
			state.directory,
			sample,
			await response.json(),
			started,
		);
		const {
			name: _name,
			requestSha256: _request,
			status: _status,
			...expectedSnapshot
		} = expected;
		expect<unknown>(snapshot).toEqual(expectedSnapshot);
	});
