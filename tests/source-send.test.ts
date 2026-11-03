import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { fixture } from "./fixtures";
import {
	sendSamples,
	prepareSendFixture,
	sendRequest,
	sendSnapshot,
	sendActor,
} from "./send-contract-fixture";
import { dispatchMailApi } from "../src/server/api/mail";
import { apiErrorResponse } from "../src/server/api/errors";
import capture from "./source-send-contracts.json";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
for (const sample of sendSamples)
	test("original send/cancel contract: " + sample.name, async () => {
		const expected = capture.cases.find((x) => x.name === sample.name);
		if (!expected) throw new Error("Missing source send case");
		await prepareSendFixture(state.db, state.directory, sample);
		const deliveries: unknown[] = [];
		const fixtureFetch = Object.assign(
			async (
				input: Parameters<typeof fetch>[0],
				init?: Parameters<typeof fetch>[1],
			) => {
				const request =
					input instanceof Request && !init ? input : new Request(input, init);
				if (!new URL(request.url).pathname.endsWith("/email/sending/send"))
					throw new Error("Unexpected fixture fetch");
				deliveries.push(await request.json());
				return sample.variant === "provider-failure"
					? Response.json(
							{
								success: false,
								errors: [{ message: "Synthetic provider failure" }],
							},
							{ status: 500 },
						)
					: Response.json({
							success: true,
							result: { message_id: "<fixture-wire@example.net>" },
						});
			},
			{ preconnect: fetch.preconnect },
		);
		const transport = spyOn(globalThis, "fetch").mockImplementation(
			fixtureFetch,
		);
		try {
			const started = Math.floor(Date.now() / 1000);
			let response: Response;
			try {
				response = await dispatchMailApi(
					sendRequest(sample, "https://send-fixture.example"),
					sendActor(sample),
				);
			} catch (error) {
				response = await apiErrorResponse(error);
			}
			expect(
				await sendSnapshot(
					state.db,
					state.directory,
					response,
					started,
					deliveries,
				),
			).toEqual(expected.snapshot);
		} finally {
			transport.mockRestore();
		}
	});
