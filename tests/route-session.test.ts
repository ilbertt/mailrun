import { expect, test } from "bun:test";
import { dehydrate, hydrate } from "@tanstack/react-query";
import { createAppQueryClient, sessionCacheOptions } from "../src/query-client";
import {
	protectedRouteAccess,
	isAdminMailRoute,
} from "../src/lib/auth/route-access";
import { owner, stranger } from "./fixtures";
import type { User } from "../src/shared/contracts";
import { fixture } from "./fixtures";
import { routeSession } from "../src/server/auth/route-session";
import { createSession } from "../src/server/auth/service";

test("the route snapshot reads current timezone, role, disabled and expired-session state together", async () => {
	const state = await fixture();
	try {
		const token = await createSession(owner.id);
		expect(await routeSession(token)).toEqual({
			user: owner,
			timeZone: null,
			needsSetup: false,
			needsOnboarding: false,
		});
		state.db.exec(
			"UPDATE users SET time_zone='America/New_York',is_primary_admin=0 WHERE id='owner'",
		);
		expect(await routeSession(token)).toEqual({
			user: { ...owner, isPrimaryAdmin: false },
			timeZone: "America/New_York",
			needsSetup: false,
			needsOnboarding: false,
		});
		state.db.exec("UPDATE users SET disabled=1 WHERE id='owner'");
		expect((await routeSession(token)).user).toBeNull();
		expect((await routeSession(token)).timeZone).toBeNull();
		state.db.exec(
			"UPDATE users SET disabled=0 WHERE id='owner'; UPDATE sessions SET expires_at=0 WHERE user_id='owner'",
		);
		expect((await routeSession(token)).user).toBeNull();
		expect((await routeSession(undefined)).user).toBeNull();
		expect((await routeSession("x".repeat(257))).user).toBeNull();
	} finally {
		await state.close();
	}
});

test("the route snapshot retains first-account and administrator-onboarding gates", async () => {
	const state = await fixture();
	try {
		const token = await createSession(owner.id);
		state.db.exec("DELETE FROM domains");
		expect(await routeSession(token)).toMatchObject({
			user: owner,
			needsSetup: false,
			needsOnboarding: true,
		});
		state.db.exec("DELETE FROM users");
		expect(await routeSession(token)).toEqual({
			user: null,
			timeZone: null,
			needsSetup: true,
			needsOnboarding: false,
		});
	} finally {
		await state.close();
	}
});

test("hydrated sessions revalidate on navigation and use current roles and revocation rather than the cached account", async () => {
	const server = createAppQueryClient(),
		browser = createAppQueryClient();
	let next: {
		user: User | null;
		needsSetup: boolean;
		needsOnboarding: boolean;
	} = { user: owner, needsSetup: false, needsOnboarding: false };
	let requests = 0;
	const options = {
		...sessionCacheOptions,
		queryFn: async () => {
			requests++;
			return next;
		},
	};
	try {
		await server.fetchQuery(options);
		hydrate(browser, dehydrate(server));
		next = { ...next, user: { ...owner, isPrimaryAdmin: false } };
		expect(
			protectedRouteAccess(await browser.fetchQuery(options), "/branding"),
		).toEqual({ redirect: "/admin" });
		next = { ...next, user: { ...owner, role: "user", isPrimaryAdmin: false } };
		expect(
			protectedRouteAccess(await browser.fetchQuery(options), "/domains"),
		).toEqual({ redirect: "/inbox" });
		next = { ...next, user: null };
		expect(
			protectedRouteAccess(await browser.fetchQuery(options), "/sent"),
		).toEqual({ redirect: "/login" });
		expect(requests).toBe(4);
	} finally {
		server.clear();
		browser.clear();
	}
});

test("protected route setup, delegated administrator, primary-only and review boundaries match source redirects", () => {
	const session = { user: owner, needsSetup: false, needsOnboarding: false };
	expect(
		protectedRouteAccess({ ...session, needsSetup: true }, "/inbox"),
	).toEqual({ redirect: "/setup" });
	expect(protectedRouteAccess({ ...session, user: null }, "/inbox")).toEqual({
		redirect: "/login",
	});
	expect(
		protectedRouteAccess({ ...session, needsOnboarding: true }, "/domains"),
	).toEqual({ redirect: "/setup" });
	expect(
		protectedRouteAccess({ ...session, needsOnboarding: true }, "/inbox"),
	).toEqual({ user: owner });
	const delegated = { ...owner, isPrimaryAdmin: false };
	for (const path of [
		"/admin",
		"/domains",
		"/mailboxes",
		"/accounts/owner",
		"/routing",
	])
		expect(protectedRouteAccess({ ...session, user: delegated }, path)).toEqual(
			{ user: delegated },
		);
	for (const path of [
		"/agent",
		"/api-keys",
		"/webhooks",
		"/backups",
		"/branding",
		"/licenses",
		"/activity",
		"/audit-logs",
		"/general",
		"/ai-usage",
	])
		expect(protectedRouteAccess({ ...session, user: delegated }, path)).toEqual(
			{ redirect: "/admin" },
		);
	expect(
		protectedRouteAccess({ ...session, user: stranger }, "/branding"),
	).toEqual({ redirect: "/inbox" });
	expect(
		protectedRouteAccess(
			{ ...session, user: stranger },
			"/agent/review/approval",
		),
	).toEqual({ user: stranger });
	expect(isAdminMailRoute("/general-other")).toBe(false);
	expect(isAdminMailRoute("/agent/review/approval")).toBe(false);
});
