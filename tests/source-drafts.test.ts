import { test, expect, beforeEach, afterEach } from "bun:test";
import { fixture } from "./fixtures";
import {
	draftSamples,
	prepareDraftFixture,
	draftRequest,
	draftSnapshot,
	draftActor,
} from "./draft-contract-fixture";
import { dispatchMailApi } from "../src/server/api/mail";
import { apiErrorResponse } from "../src/server/api/errors";
import capture from "./source-draft-contracts.json";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
for (const sample of draftSamples)
	test("original draft contract: " + sample.name, async () => {
		const expected = capture.cases.find((item) => item.name === sample.name);
		if (!expected) throw new Error("Missing source capture");
		await prepareDraftFixture(state.db, state.directory, sample);
		const started = Math.floor(Date.now() / 1000);
		let response: Response;
		try {
			response = await dispatchMailApi(
				draftRequest(sample, "https://draft-fixture.example"),
				draftActor(sample),
			);
		} catch (error) {
			response = await apiErrorResponse(error);
		}
		expect(
			await draftSnapshot(state.db, state.directory, response, started),
		).toEqual(expected.snapshot);
	});
