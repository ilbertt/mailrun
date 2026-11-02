import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { fixture } from "./fixtures";
import {
	samples,
	prepare,
	requestFor,
	snapshot,
	actor,
} from "./contacts-templates-fixture";
import { dispatchMailApi } from "../src/server/api/mail";
import { apiErrorResponse } from "../src/server/api/errors";
import capture from "./source-contacts-templates-contracts.json";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
for (const sample of samples)
	test("original contacts/templates contract: " + sample.name, async () => {
		const expected = capture.cases.find((x) => x.name === sample.name);
		if (!expected) throw new Error("Missing source contract");
		await prepare(state.db, state.directory, sample);
		const transport = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async () => {
					throw new Error("Unexpected external request");
				},
				{ preconnect: fetch.preconnect },
			),
		);
		try {
			const started = Math.floor(Date.now() / 1000);
			let response: Response;
			try {
				response = await dispatchMailApi(
					requestFor(sample, "https://contacts-fixture.example"),
					actor(sample),
				);
			} catch (error) {
				response = await apiErrorResponse(error);
			}
			expect(
				await snapshot(state.db, state.directory, response, started),
			).toEqual(expected.snapshot);
		} finally {
			transport.mockRestore();
		}
	});
