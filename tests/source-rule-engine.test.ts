import { test, expect, beforeEach, afterEach } from "bun:test";
import { fixture } from "./fixtures";
import {
	engineSamples,
	engineInput,
	engineRule,
	prepareRuleEngineFixture,
} from "./rule-engine-fixture";
import {
	matchesRule,
	resolveRouting,
	inboxDestination,
} from "../src/server/mail/routing";
import capture from "./source-rule-engine.json";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
for (const sample of engineSamples)
	test("original rule execution: " + sample.name, async () => {
		const expected = capture.cases.find((x) => x.name === sample.name);
		if (!expected) throw new Error("Missing original engine case");
		prepareRuleEngineFixture(state.db, sample);
		const input = engineInput(sample);
		let result: unknown;
		if (sample.kind === "match")
			result = await matchesRule(engineRule(sample), input);
		else if (sample.kind === "inbox")
			result = await inboxDestination("mailbox", input);
		else {
			const value = await resolveRouting(input.to, input.from, false, {
				subject: input.subject,
				content: input.content,
			});
			result = value
				? {
						action: value.action,
						mailboxId: value.mailbox?.id ?? null,
						forwardTo: "forwardTo" in value ? value.forwardTo : null,
						keepCopy: "keepCopy" in value ? value.keepCopy : null,
						reason: "reason" in value ? value.reason : null,
					}
				: null;
		}
		expect(result).toEqual(expected.result);
	});
