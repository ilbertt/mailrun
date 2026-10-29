import { afterEach, beforeEach, expect, test } from "bun:test";
import { authFetch, clearClientSessionToken } from "../src/lib/auth/client";
import { expectedDraftRevision } from "../src/server/api/drafts";

let windowDescriptor: PropertyDescriptor | undefined;
let storageDescriptor: PropertyDescriptor | undefined;
let previousFetch: typeof fetch;

beforeEach(() => {
	windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
	storageDescriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		"localStorage",
	);
	previousFetch = globalThis.fetch;
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {
			location: {
				href: "https://mail.example.com/inbox",
				origin: "https://mail.example.com",
			},
			dispatchEvent() {},
		},
	});
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem() {
				return null;
			},
			removeItem() {},
		},
	});
	clearClientSessionToken();
});
afterEach(() => {
	globalThis.fetch = previousFetch;
	for (const [key, descriptor] of [
		["window", windowDescriptor],
		["localStorage", storageDescriptor],
	] as const) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

test("draft autosave, upload and send retain optimistic locking through proxy-weakened ETags", async () => {
	let revision = 0;
	const seen: string[] = [];
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "https://mail.example.com");
			if (url.pathname !== "/api/drafts") {
				const request = new Request(url, init);
				seen.push(request.headers.get("If-Match") ?? "missing");
				expect(expectedDraftRevision(request, revision)).toBe(revision);
				revision++;
			}
			return Response.json(
				{},
				{
					headers: {
						"X-Mailflare-Draft-Id": "proxy-draft",
						"X-Mailflare-Draft-Revision": String(revision),
						ETag: `W/"${revision}"`,
					},
				},
			);
		},
		{ preconnect: previousFetch.preconnect },
	);
	await authFetch("/api/drafts", { method: "POST", body: "{}" });
	await authFetch("/api/drafts/proxy-draft", { method: "PATCH", body: "{}" });
	await authFetch("/api/drafts/proxy-draft/attachments", {
		method: "POST",
		body: new FormData(),
	});
	const send = new FormData();
	send.set("draftId", "proxy-draft");
	await authFetch("/api/send", { method: "POST", body: send });
	expect(seen).toEqual(['"0"', '"1"', '"2"']);
	try {
		expectedDraftRevision(
			new Request("https://mail.example.com/api/send", {
				headers: { "If-Match": seen[0]! },
			}),
			revision,
		);
		throw new Error("A stale tab must not overwrite the current draft");
	} catch (error) {
		expect(error).toBeInstanceOf(Response);
		expect((error as Response).status).toBe(409);
	}
});
