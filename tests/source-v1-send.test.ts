import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { fixture } from "./fixtures";
import {
	v1SendSamples,
	prepareV1Send,
	v1SendRequest,
	v1SendSnapshot,
} from "./v1-send-fixture";
import { serveV1Api } from "../src/server/api/v1";
import capture from "./source-v1-send-contracts.json";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
for (const sample of v1SendSamples)
	test("original public send: " + sample.name, async () => {
		const expected = capture.cases.find((row) => row.name === sample.name);
		if (!expected) throw new Error("Missing original v1 send case");
		await prepareV1Send(state.db, state.directory, sample);
		const deliveries: unknown[] = [];
		const transport = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (
					input: Parameters<typeof fetch>[0],
					init?: Parameters<typeof fetch>[1],
				) => {
					const request =
						input instanceof Request && !init
							? input
							: new Request(input, init);
					if (!new URL(request.url).pathname.endsWith("/email/sending/send"))
						throw new Error("Unexpected public-send fixture request");
					deliveries.push(await request.json());
					return sample.failure
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
			),
		);
		try {
			const started = Math.floor(Date.now() / 1000),
				response = await serveV1Api(
					v1SendRequest(sample, "https://v1-send-fixture.example"),
				);
			expect(
				await v1SendSnapshot(
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
