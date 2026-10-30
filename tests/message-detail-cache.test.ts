import { beforeEach, afterEach, expect, test } from "bun:test";
import { setClientSessionToken } from "../src/lib/auth/client";
import { clearMailboxClientState } from "../src/components/mailbox-provider-utils";
import {
	clearMessageDetailCache,
	fetchCachedMessageDetail,
	getCachedMessageDetail,
} from "../src/lib/messages/detail-cache";

let windowDescriptor: PropertyDescriptor | undefined,
	storageDescriptor: PropertyDescriptor | undefined,
	previousFetch: typeof fetch;
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
				href: "https://fixture.example/inbox",
				origin: "https://fixture.example",
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
		},
	});
	clearMessageDetailCache();
});
afterEach(() => {
	globalThis.fetch = previousFetch;
	clearMessageDetailCache();
	for (const [key, descriptor] of [
		["window", windowDescriptor],
		["localStorage", storageDescriptor],
	] as const) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

test("a cleared detail request cannot repopulate the cache or remove the new session's pending request", async () => {
	const old = Promise.withResolvers<Response>(),
		current = Promise.withResolvers<Response>();
	let requests = 0;
	globalThis.fetch = Object.assign(
		async () => (++requests === 1 ? old.promise : current.promise),
		{ preconnect: previousFetch.preconnect },
	);
	const former = fetchCachedMessageDetail("message");
	clearMessageDetailCache();
	const active = fetchCachedMessageDetail("message");
	old.resolve(
		Response.json({
			body: { textBody: "Former account content", htmlBody: null },
		}),
	);
	expect(await former).toEqual({});
	expect(getCachedMessageDetail("message")).toBeUndefined();
	const shared = fetchCachedMessageDetail("message");
	expect(requests).toBe(2);
	current.resolve(
		Response.json({
			body: { textBody: "Current account content", htmlBody: null },
		}),
	);
	expect((await active).body?.textBody).toBe("Current account content");
	expect((await shared).body?.textBody).toBe("Current account content");
	expect(getCachedMessageDetail("message")?.body?.textBody).toBe(
		"Current account content",
	);
});

test("a forced newer detail request keeps its cache entry when the earlier request finishes last", async () => {
	const old = Promise.withResolvers<Response>(),
		current = Promise.withResolvers<Response>();
	let requests = 0;
	globalThis.fetch = Object.assign(
		async () => (++requests === 1 ? old.promise : current.promise),
		{ preconnect: previousFetch.preconnect },
	);
	const former = fetchCachedMessageDetail("message"),
		active = fetchCachedMessageDetail("message", true);
	current.resolve(
		Response.json({ body: { textBody: "Newer detail", htmlBody: null } }),
	);
	await active;
	old.resolve(
		Response.json({ body: { textBody: "Older detail", htmlBody: null } }),
	);
	await former;
	expect(getCachedMessageDetail("message")?.body?.textBody).toBe(
		"Newer detail",
	);
});

test("an account transition clears cached details and discards pending content before React cache listeners run", async () => {
	const pending = Promise.withResolvers<Response>();
	let requests = 0;
	globalThis.fetch = Object.assign(
		async () =>
			++requests === 1
				? Response.json({
						body: { textBody: "Old cached content", htmlBody: null },
					})
				: pending.promise,
		{ preconnect: previousFetch.preconnect },
	);
	await fetchCachedMessageDetail("message");
	const old = fetchCachedMessageDetail("message", true);
	setClientSessionToken("new-account");
	expect(getCachedMessageDetail("message")).toBeUndefined();
	pending.resolve(
		Response.json({
			body: { textBody: "Old pending content", htmlBody: null },
		}),
	);
	expect(await old).toEqual({});
	expect(getCachedMessageDetail("message")).toBeUndefined();
});

test("blocked local storage does not interrupt the mailbox cache reset used by authentication changes", () => {
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem() {
				throw new Error("Storage disabled");
			},
			removeItem() {
				throw new Error("Storage disabled");
			},
		},
	});
	expect(() => clearMailboxClientState()).not.toThrow();
});
