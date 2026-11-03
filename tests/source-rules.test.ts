import { test, expect, beforeEach, afterEach } from "bun:test";
import { fixture } from "./fixtures";
import {
	ruleSamples,
	prepareRuleFixture,
	ruleRequest,
	ruleSnapshot,
	ruleActor,
} from "./rule-contract-fixture";
import { dispatchMailApi } from "../src/server/api/mail";
import { apiErrorResponse } from "../src/server/api/errors";
import capture from "./source-rule-contracts.json";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
for (const sample of ruleSamples)
	test("original rule contract: " + sample.name, async () => {
		const expected = capture.cases.find((x) => x.name === sample.name);
		if (!expected) throw new Error("Missing original rule case");
		prepareRuleFixture(state.db, sample);
		const started = Math.floor(Date.now() / 1000);
		let response: Response;
		try {
			response = await dispatchMailApi(
				ruleRequest(sample, "https://rule-fixture.example"),
				ruleActor(sample),
			);
		} catch (error) {
			response = await apiErrorResponse(error);
		}
		expect(await ruleSnapshot(state.db, response, started)).toEqual(
			expected.snapshot,
		);
	});
