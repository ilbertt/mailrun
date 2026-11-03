import { test, expect, beforeEach, afterEach } from "bun:test";
import { fixture } from "./fixtures";
import {
	aliasRoutingCases,
	prepareAliasRoutingFixture,
} from "./alias-contract-fixture";
import { resolveRouting } from "../src/server/mail/routing";
import capture from "./source-alias-routing.json";
import { z } from "zod";
const routingResult = z
	.object({
		action: z.enum(["store", "forward", "reject"]),
		mailboxId: z.string().nullable(),
	})
	.nullable();
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
for (const sample of aliasRoutingCases)
	test("original alias routing: " + sample.name, async () => {
		prepareAliasRoutingFixture(state.db, sample);
		const expected = capture.cases.find((x) => x.name === sample.name);
		if (!expected) throw new Error("Missing source routing case");
		const value = await resolveRouting(sample.to, "sender@example.org", false);
		expect(
			value
				? { action: value.action, mailboxId: value.mailbox?.id ?? null }
				: null,
		).toEqual(routingResult.parse(expected.result));
	});
