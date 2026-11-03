import { test, expect, beforeEach, afterEach } from "bun:test";
import { fixture } from "./fixtures";
import {
	aliasSamples,
	prepareAliasFixture,
	aliasRequest,
	aliasSnapshot,
	aliasActor,
} from "./alias-contract-fixture";
import { dispatchMailApi } from "../src/server/api/mail";
import { apiErrorResponse } from "../src/server/api/errors";
import capture from "./source-alias-contracts.json";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
for (const sample of aliasSamples)
	test("original alias contract: " + sample.name, async () => {
		const expected = capture.cases.find((item) => item.name === sample.name);
		if (!expected) throw new Error("Missing source alias capture");
		prepareAliasFixture(state.db, sample);
		const started = Math.floor(Date.now() / 1000);
		let response: Response;
		try {
			response = await dispatchMailApi(
				aliasRequest(sample, "https://alias-fixture.example"),
				aliasActor(sample),
			);
		} catch (error) {
			response = await apiErrorResponse(error);
		}
		expect(await aliasSnapshot(state.db, response, started)).toEqual(
			expected.snapshot,
		);
	});
