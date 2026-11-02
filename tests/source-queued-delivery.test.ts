import {
	test,
	expect,
	beforeEach,
	afterEach,
	setSystemTime,
	spyOn,
} from "bun:test";
import { fixture } from "./fixtures";
import {
	queueSamples,
	QUEUED_AT,
	DUE_AT,
	DELIVER_AT,
	QUEUE_ORIGIN,
	queueDeliveryTime,
	restoreQueuedBefore,
	applyQueuedChanges,
	queuedSnapshot,
} from "./queued-delivery-fixture";
import { deliverJob } from "../src/server/mail/send";
import capture from "./source-queued-delivery-contracts.json";
let state: Awaited<ReturnType<typeof fixture>>, oldOrigin: string | undefined;
beforeEach(async () => {
	state = await fixture();
	oldOrigin = process.env.APP_URL;
	process.env.APP_URL = QUEUE_ORIGIN;
	setSystemTime(QUEUED_AT);
});
afterEach(async () => {
	setSystemTime();
	if (oldOrigin === undefined) delete process.env.APP_URL;
	else process.env.APP_URL = oldOrigin;
	await state.close();
});
for (const sample of queueSamples)
	test("original queued delivery: " + sample.name, async () => {
		const expected = capture.cases.find((item) => item.name === sample.name);
		if (!expected) throw new Error("Missing original queue capture");
		const identity = await restoreQueuedBefore(
			state.db,
			state.directory,
			expected.before,
		);
		await applyQueuedChanges(state.db, state.directory, sample, identity);
		setSystemTime(queueDeliveryTime(sample));
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
						throw new Error("Unexpected queued fixture fetch");
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
			let response: Response;
			try {
				await deliverJob(identity.jobId);
				response = Response.json({ ok: true });
			} catch (error) {
				response = Response.json(
					{
						error:
							error instanceof Error
								? error.message
								: error instanceof Response
									? await error.text()
									: "Source queue failed",
					},
					{ status: 500 },
				);
			}
			expect(
				await queuedSnapshot(
					state.db,
					state.directory,
					response,
					deliveries,
					identity,
				),
			).toEqual(expected.snapshot);
		} finally {
			transport.mockRestore();
		}
	});
