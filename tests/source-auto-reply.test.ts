import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { fixture } from "./fixtures";
import {
	autoReplySamples,
	prepareAutoReply,
	autoReplyInput,
	autoReplySnapshot,
} from "./auto-reply-fixture";
import { queueAutoReply } from "../src/server/mail/auto-reply";
import { deliverJob } from "../src/server/mail/send";
import capture from "./source-auto-reply-contracts.json";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
for (const sample of autoReplySamples)
	test("original automatic-reply behavior: " + sample.name, async () => {
		const expected = capture.cases.find((x) => x.name === sample.name);
		if (!expected) throw new Error("Missing original auto-reply case");
		await prepareAutoReply(state.db, state.directory, sample);
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
						throw new Error("Unexpected fixture auto-reply fetch");
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
			const started = Math.floor(Date.now() / 1000);
			let response: Response;
			try {
				const job = await queueAutoReply({
					...autoReplyInput(sample),
					threadId: "incoming-thread",
				});
				if (job) await deliverJob(job);
				response = Response.json({ ok: true });
			} catch (error) {
				response = Response.json(
					{
						error:
							error instanceof Error
								? error.message
								: error instanceof Response
									? await error.text()
									: "Source function failed",
					},
					{ status: 500 },
				);
			}
			expect(
				await autoReplySnapshot(
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
