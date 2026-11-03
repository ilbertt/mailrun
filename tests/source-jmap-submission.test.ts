import { LocalStorage } from "../src/server/storage";
import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { fixture } from "./fixtures";
import {
	jmapSubmissionSamples,
	prepareJmapSubmission,
	jmapSubmissionRequest,
	jmapSubmissionSnapshot,
} from "./jmap-submission-fixture";
import { handleJmapRequest } from "../src/server/jmap/handler";
import capture from "./source-jmap-submission-contracts.json";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
for (const sample of jmapSubmissionSamples)
	test("original JMAP submission: " + sample.name, async () => {
		const expected = capture.cases.find((row) => row.name === sample.name);
		if (!expected) throw new Error("Missing original JMAP submission case");
		await prepareJmapSubmission(state.db, state.directory, sample);
		const deliveries: unknown[] = [];
		const originalDelete = LocalStorage.prototype.delete;
		const deleted = spyOn(LocalStorage.prototype, "delete").mockImplementation(
			async function (this: LocalStorage, key) {
				if (sample.variant === "cleanup-failure" && key === "stored.txt")
					throw new Error("Synthetic object cleanup failure");
				return originalDelete.call(this, key);
			},
		);
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
						throw new Error("Unexpected JMAP submission fixture request");
					deliveries.push(await request.json());
					return sample.failure || (sample.failFirst && deliveries.length === 1)
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
				response = await handleJmapRequest(
					jmapSubmissionRequest(sample, "https://jmap-submit-fixture.example"),
				);
			expect(
				await jmapSubmissionSnapshot(
					state.db,
					state.directory,
					response,
					started,
					deliveries,
				),
			).toEqual(expected.snapshot);
		} finally {
			transport.mockRestore();
			deleted.mockRestore();
		}
	});
