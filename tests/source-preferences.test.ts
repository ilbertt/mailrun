import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { fixture } from "./fixtures";
import {
	preferenceSamples,
	preparePreferences,
	preferenceRequest,
	preferenceSnapshot,
	preferenceActor,
} from "./preferences-fixture";
import { dispatchMailApi } from "../src/server/api/mail";
import { apiErrorResponse } from "../src/server/api/errors";
import capture from "./source-preferences-contracts.json";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
for (const sample of preferenceSamples)
	test(
		"original profile/preferences/mailbox settings: " + sample.name,
		async () => {
			const expected = capture.cases.find((x) => x.name === sample.name);
			if (!expected) throw new Error("Missing source preference case");
			await preparePreferences(state.db, state.directory, sample);
			const transport = spyOn(globalThis, "fetch").mockImplementation(
				Object.assign(
					async () => {
						throw new Error("Unexpected external preference request");
					},
					{ preconnect: fetch.preconnect },
				),
			);
			try {
				const started = Math.floor(Date.now() / 1000);
				let response: Response;
				try {
					response = await dispatchMailApi(
						preferenceRequest(sample, "https://preferences-fixture.example"),
						preferenceActor(sample),
					);
				} catch (error) {
					response = await apiErrorResponse(error);
				}
				expect(await preferenceSnapshot(state.db, response, started)).toEqual(
					expected.snapshot,
				);
			} finally {
				transport.mockRestore();
			}
		},
	);
