import { test, expect } from "bun:test";
import { readDraftAttachmentFiles } from "../src/server/http/draft-form";

test("draft multipart parsing bounds streamed bytes and cancels oversized requests without trusting Content-Length", async () => {
	const boundary = "mailrun-size-boundary";
	let pulls = 0,
		cancelled = false;
	const prefix = new TextEncoder().encode(
		`--${boundary}\r\nContent-Disposition: form-data; name="attachments"; filename="large.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
	);
	const chunk = new Uint8Array(1024 * 1024);
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(pulls++ === 0 ? prefix : chunk);
		},
		cancel() {
			cancelled = true;
		},
	});
	const request = new Request(
		"https://draft-fixture.example/api/drafts/draft/attachments",
		{
			method: "POST",
			headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
			body,
		},
	);
	let failure: unknown;
	try {
		await readDraftAttachmentFiles(request);
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(Response);
	if (!(failure instanceof Response)) throw new Error("Missing size rejection");
	expect(failure.status).toBe(413);
	expect(await failure.text()).toBe("Invalid attachment request");
	await Bun.sleep(0);
	expect(cancelled).toBe(true);
	expect(pulls).toBeLessThanOrEqual(33);
});

test("draft multipart declared overflow rejects before reading the request body", async () => {
	let pulls = 0;
	const request = new Request("https://draft-fixture.example/upload", {
		method: "POST",
		headers: {
			"Content-Type": "multipart/form-data; boundary=fixture",
			"Content-Length": String(31 * 1024 * 1024),
		},
		body: new ReadableStream({
			pull() {
				pulls++;
			},
		}),
	});
	let failure: unknown;
	try {
		await readDraftAttachmentFiles(request);
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(Response);
	if (!(failure instanceof Response)) throw new Error("Missing size rejection");
	expect(failure.status).toBe(413);
	expect(pulls).toBeLessThanOrEqual(1);
	await request.body?.cancel();
});
