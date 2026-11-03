import { test, expect, beforeEach, afterEach } from "bun:test";
import { fixture } from "./fixtures";
import { dispatchMailApi } from "../src/server/api/mail";
import { apiErrorResponse } from "../src/server/api/errors";
import {
	detailSamples,
	detailPath,
	detailActor,
	prepareDetailFixture,
	detailSnapshot,
} from "./message-detail-fixture";
import capture from "./source-message-details.json";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
for (const sample of detailSamples.filter(
	(sample) => sample.endpoint !== "attachment",
))
	test(`original message detail contract: ${sample.name}`, async () => {
		const expected = capture.cases.find((value) => value.name === sample.name);
		if (!expected) throw new Error("Missing original capture: " + sample.name);
		await prepareDetailFixture(state.db, state.directory, sample);
		let response: Response;
		try {
			response = await dispatchMailApi(
				new Request("https://mail.example" + detailPath(sample)),
				detailActor(sample),
			);
		} catch (error) {
			response = await apiErrorResponse(error);
		}
		const { name: _name, ...snapshot } = expected;
		expect(await detailSnapshot(response)).toEqual(snapshot);
	});

test("shared draft bodies and files retain the native author restriction", async () => {
	const sample = {
		name: "native-private-draft",
		endpoint: "detail",
		id: "draft",
		actor: "stranger",
		permission: "full_access",
	} as const;
	await prepareDetailFixture(state.db, state.directory, sample);
	state.db.exec(
		"UPDATE message_attachments SET message_id='draft' WHERE id='read-attachment'",
	);
	for (const endpoint of ["detail", "thread", "metadata"] as const) {
		const response = await dispatchMailApi(
			new Request("https://mail.example" + detailPath({ ...sample, endpoint })),
			detailActor(sample),
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Not found" });
	}
	const { messageFile } = await import("../src/server/mail/repository");
	await expect(
		messageFile(detailActor(sample), "draft", "read-attachment"),
	).rejects.toThrow("Message not found");
});
