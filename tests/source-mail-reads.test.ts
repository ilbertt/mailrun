import { test, expect, beforeEach, afterEach } from "bun:test";
import { fixture } from "./fixtures";
import { serveV1Api } from "../src/server/api/v1";
import { dispatchMailApi } from "../src/server/api/mail";
import { apiErrorResponse } from "../src/server/api/errors";
import {
	readSamples,
	readApiKey,
	readExpectedBody,
	readPath,
	readActor,
	prepareReadFixture,
	normalizeReadBody,
} from "./mail-read-fixture";
import capture from "./source-mail-reads.json";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
for (const sample of readSamples)
	test(`${sample.name === "v1-shared-read" ? "native draft-body restriction" : "original mailbox read contract"}: ${sample.name}`, async () => {
		const expected = capture.cases.find((row) => row.name === sample.name);
		if (!expected) throw new Error("Missing original capture: " + sample.name);
		prepareReadFixture(state.db, sample);
		const request = new Request("https://mail.example" + readPath(sample), {
			headers: {
				...(sample.kind === "v1"
					? { Authorization: "Bearer " + readApiKey }
					: {}),
				...(sample.headerZone ? { "X-Time-Zone": sample.headerZone } : {}),
			},
		});
		let response: Response;
		try {
			response =
				sample.kind === "v1"
					? await serveV1Api(request)
					: await dispatchMailApi(request, readActor(sample));
		} catch (error) {
			response = await apiErrorResponse(error);
		}
		expect(response.status).toBe(expected.status);
		expect(normalizeReadBody(await response.json())).toEqual(
			readExpectedBody(sample, expected.body),
		);
	});
