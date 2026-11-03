import { test, expect, beforeEach, afterEach } from "bun:test";
import { importMessageFiles } from "../src/components/settings/import-messages-utils";
let descriptor: PropertyDescriptor | undefined;
let reply = { status: 200, text: '{"imported":1,"skipped":0,"errors":[]}' };
let uncaught: unknown;
beforeEach(() => {
	descriptor = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
	uncaught = undefined;
	class FixtureRequest {
		upload: {
			onprogress?: (event: {
				lengthComputable: boolean;
				loaded: number;
				total: number;
			}) => void;
		} = {};
		onload?: () => void;
		onerror?: () => void;
		status = 0;
		responseText = "";
		open() {}
		setRequestHeader() {}
		send(body: FormData) {
			expect(body.get("mailboxId")).toBe("mailbox");
			expect(body.getAll("files")).toHaveLength(1);
			queueMicrotask(() => {
				this.status = reply.status;
				this.responseText = reply.text;
				try {
					this.upload.onprogress?.({
						lengthComputable: true,
						loaded: 1,
						total: 1,
					});
					this.onload?.();
				} catch (error) {
					uncaught = error;
				}
			});
		}
	}
	Object.defineProperty(globalThis, "XMLHttpRequest", {
		configurable: true,
		value: FixtureRequest,
	});
});
afterEach(() => {
	if (descriptor)
		Object.defineProperty(globalThis, "XMLHttpRequest", descriptor);
	else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
});
const run = () => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		importMessageFiles(
			"mailbox",
			[new File(["MIME"], "fixture.eml")],
			"system:inbox",
		),
		new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error("Import callback did not settle")),
				200,
			);
		}),
	]).finally(() => clearTimeout(timer));
};
test("browser import accepts the source result contract and completes progress", async () => {
	reply = { status: 200, text: '{"imported":1,"skipped":0,"errors":[]}' };
	expect(await run()).toEqual({ imported: 1, skipped: 0, errors: [] });
	expect(uncaught).toBeUndefined();
});
test("browser import rejects JSON and proxy HTML failures without leaving its promise pending", async () => {
	for (const response of [
		{ status: 413, text: '{"error":"Request body too large"}' },
		{ status: 413, text: "<html>Too large</html>" },
		{ status: 502, text: "<html>Bad gateway</html>" },
		{ status: 502, text: "null" },
	]) {
		reply = response;
		await expect(run()).rejects.toThrow(
			/body too large|upload is too large|Import failed|Invalid import response/,
		);
		expect(uncaught).toBeUndefined();
	}
});
test("browser import rejects malformed success responses instead of reporting a false completion", async () => {
	for (const text of [
		"null",
		"{}",
		'{"imported":"one","skipped":0,"errors":[]}',
	]) {
		reply = { status: 200, text };
		await expect(run()).rejects.toThrow("Invalid import response");
		expect(uncaught).toBeUndefined();
	}
});
