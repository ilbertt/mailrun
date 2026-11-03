import { beforeEach, afterEach, expect, test } from "bun:test";
import {
	probeRouteSession,
	type RouteSessionState,
	type SessionSnapshot,
} from "../src/lib/auth/route-probe";
import {
	clearClientSessionToken,
	setClientSessionToken,
	SessionUnauthorizedError,
	getClientPrincipalId,
	clientSessionScope,
	recordClientTransport,
} from "../src/lib/auth/client";
import { owner } from "./fixtures";

let oldWindow: PropertyDescriptor | undefined,
	oldStorage: PropertyDescriptor | undefined;
beforeEach(() => {
	oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	const store = new Map<string, string>();
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {
			dispatchEvent() {},
			location: {
				href: "https://fixture.example/inbox",
				origin: "https://fixture.example",
			},
		},
	});
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, value),
			removeItem: (key: string) => store.delete(key),
		},
	});
	clearClientSessionToken();
});
afterEach(() => {
	for (const [name, descriptor] of [
		["window", oldWindow],
		["localStorage", oldStorage],
	] as const) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});
const snapshot: SessionSnapshot = {
	user: owner,
	timeZone: "Europe/Rome",
	transport: "cookie",
	needsSetup: false,
	needsOnboarding: false,
};
const previous: RouteSessionState = {
	...snapshot,
	verified: true,
	fromServer: true,
};

test("a superseded navigation cannot publish a different principal from its late probe", async () => {
	setClientSessionToken("stored-session");
	recordClientTransport("cookie", clientSessionScope(), "current-user");
	const pending = Promise.withResolvers<SessionSnapshot>();
	let active = true;
	const old = probeRouteSession(() => pending.promise, {
		signal: new AbortController().signal,
		isActive: () => active,
	});
	active = false;
	pending.resolve(snapshot);
	await expect(old).rejects.toBeDefined();
	expect(getClientPrincipalId()).toBe("current-user");
});

test("transient probe errors preserve the last UI snapshot without claiming authorization", async () => {
	const result = await probeRouteSession(
		async () => {
			throw new TypeError("Network unavailable");
		},
		{ signal: new AbortController().signal, previous },
	);
	expect(result).toEqual({ ...snapshot, verified: false, fromServer: false });
	const unknown = await probeRouteSession(
		async () => {
			throw new Error("HTTP 503");
		},
		{ signal: new AbortController().signal },
	);
	expect(unknown.user).toBeNull();
	expect(unknown.verified).toBe(false);
});
test("a stalled probe is bounded even when its transport ignores cancellation", async () => {
	const result = await probeRouteSession(() => new Promise(() => {}), {
		signal: new AbortController().signal,
		previous,
		timeoutMs: 10,
	});
	expect(result.verified).toBe(false);
	expect(result.user).toEqual(owner);
});
test("a confirmed unauthorized probe redirects rather than retaining a cached identity", async () => {
	const result = await probeRouteSession(
		async () => {
			throw new SessionUnauthorizedError();
		},
		{ signal: new AbortController().signal, previous },
	);
	expect(result.verified).toBe(true);
	expect(result.user).toBeNull();
});
test("navigation cancellation and account changes cannot reuse the former account's failed probe", async () => {
	const controller = new AbortController(),
		pending = Promise.withResolvers<SessionSnapshot>();
	const cancelled = probeRouteSession(() => pending.promise, {
		signal: controller.signal,
		previous,
	});
	controller.abort();
	await expect(cancelled).rejects.toBeDefined();
	const delayed = Promise.withResolvers<SessionSnapshot>();
	const stale = probeRouteSession(() => delayed.promise, {
		signal: new AbortController().signal,
		previous,
	});
	setClientSessionToken("different-account");
	delayed.resolve(snapshot);
	await expect(stale).rejects.toBeDefined();
});
