import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	authFetch,
	clearClientSessionToken,
	getClientSessionToken,
	setClientSessionToken,
} from "../src/lib/auth/client";
import { expectedDraftRevision } from "../src/server/api/drafts";

let windowDescriptor: PropertyDescriptor | undefined;
let storageDescriptor: PropertyDescriptor | undefined;
let previousFetch: typeof fetch;
let stored: Map<string, string>, redirects: string[], events: string[];

beforeEach(() => {
	windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
	storageDescriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		"localStorage",
	);
	previousFetch = globalThis.fetch;
	stored = new Map();
	redirects = [];
	events = [];
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {
			location: {
				href: "https://mail.example.com/inbox",
				origin: "https://mail.example.com",
				assign(path: string) {
					redirects.push(path);
				},
			},
			dispatchEvent(event: Event) {
				events.push(event.type);
			},
		},
	});
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem(key: string) {
				return stored.get(key) ?? null;
			},
			setItem(key: string, value: string) {
				stored.set(key, value);
			},
			removeItem(key: string) {
				stored.delete(key);
			},
		},
	});
	clearClientSessionToken();
});

test("an old session's delayed unauthorized response cannot sign out a newly selected account", async () => {
	const pending = Promise.withResolvers<Response>();
	globalThis.fetch = Object.assign(async () => pending.promise, {
		preconnect: previousFetch.preconnect,
	});
	setClientSessionToken("first-session");
	const old = authFetch("/api/messages/old");
	setClientSessionToken("second-session");
	pending.resolve(new Response("Unauthorized", { status: 401 }));
	expect((await old).status).toBe(401);
	expect(getClientSessionToken()).toBe("second-session");
	expect(redirects).toEqual([]);
});

test("an unauthorized response from the current session still signs out and redirects", async () => {
	globalThis.fetch = Object.assign(
		async () => new Response("Unauthorized", { status: 401 }),
		{ preconnect: previousFetch.preconnect },
	);
	setClientSessionToken("current-session");
	expect((await authFetch("/api/messages/current")).status).toBe(401);
	expect(getClientSessionToken()).toBeNull();
	expect(redirects).toEqual(["/login"]);
});

test("switching away and back does not accept a previous request's draft revision or mutation events", async () => {
	const pending = Promise.withResolvers<Response>();
	let requests = 0,
		subsequentRevision: string | null = null;
	globalThis.fetch = Object.assign(
		async (_input: RequestInfo | URL, init?: RequestInit) => {
			if (++requests === 1) return pending.promise;
			subsequentRevision = new Headers(init?.headers).get("If-Match");
			return Response.json({});
		},
		{ preconnect: previousFetch.preconnect },
	);
	setClientSessionToken("first-session");
	const old = authFetch("/api/drafts", { method: "POST", body: "{}" });
	setClientSessionToken("second-session");
	setClientSessionToken("first-session");
	events.length = 0;
	pending.resolve(
		Response.json(
			{},
			{
				headers: {
					"X-Mailflare-Draft-Id": "old-draft",
					"X-Mailflare-Draft-Revision": "7",
				},
			},
		),
	);
	await old;
	expect(events).not.toContain("mailflare:api-mutated");
	await authFetch("/api/drafts/old-draft", { method: "PATCH", body: "{}" });
	expect(subsequentRevision).toBeNull();
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
