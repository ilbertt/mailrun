import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { fixture } from "./fixtures";
import {
	mailboxManagementSamples,
	prepareMailboxManagement,
	mailboxManagementRequest,
	mailboxManagementActor,
	mailboxManagementSnapshot,
	mailboxResolutionAddresses,
} from "./mailbox-management-fixture";
import { dispatchMailApi } from "../src/server/api/mail";
import { apiErrorResponse } from "../src/server/api/errors";
import { resolveRouting } from "../src/server/mail/routing";
import capture from "./source-mailbox-management-contracts.json";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
for (const sample of mailboxManagementSamples)
	test("original mailbox management: " + sample.name, async () => {
		const expected = capture.cases.find((x) => x.name === sample.name);
		if (!expected) throw new Error("Missing original mailbox management case");
		await prepareMailboxManagement(state.db, state.directory, sample);
		const transport = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async () => {
					throw new Error("Unexpected external mailbox request");
				},
				{ preconnect: fetch.preconnect },
			),
		);
		try {
			const started = Math.floor(Date.now() / 1000);
			let response: Response;
			try {
				response = await dispatchMailApi(
					mailboxManagementRequest(sample, "https://mailboxes-fixture.example"),
					mailboxManagementActor(state.db, sample),
				);
			} catch (error) {
				response = await apiErrorResponse(error);
			}
			const resolutions = [];
			for (const address of mailboxResolutionAddresses) {
				const result = await resolveRouting(address, "", false);
				resolutions.push({ address, mailboxId: result?.mailbox?.id ?? null });
			}
			expect(
				await mailboxManagementSnapshot(
					state.db,
					state.directory,
					response,
					started,
					resolutions,
				),
			).toEqual(expected.snapshot);
		} finally {
			transport.mockRestore();
		}
	});
