import { queryOptions, type QueryClient } from "@tanstack/react-query";
import {
	sessionFn,
	mailboxesFn,
	messagesFn,
	threadFn,
	mailSettingsFn,
	localeFn,
} from "./functions";
import type { ListInput } from "./shared/contracts";
import { documentCacheOptions, sessionCacheOptions } from "./query-client";
import {
	probeRouteSession,
	type RouteSessionState,
} from "./lib/auth/route-probe";

import { isAdminMailRoute } from "./lib/auth/route-access";
const navigationProbes = new WeakMap<
	QueryClient,
	{ path: string; revision: number }
>();
function authBoundary(path: string) {
	if (isAdminMailRoute(path)) return "admin";
	if (path.startsWith("/settings")) return "settings";
	if (path.startsWith("/calendar") || path === "/booking") return "calendar";
	if (path.startsWith("/drive")) return "drive";
	if (
		["/login", "/forgot-password", "/reset-password", "/setup"].includes(path)
	)
		return path;
	return "dashboard";
}

export const documentQuery = () =>
	queryOptions({
		...documentCacheOptions,
		queryFn: () => localeFn(),
	});

export const sessionQuery = (pathname?: string, revision?: number) =>
	queryOptions({
		...sessionCacheOptions,
		queryKey: pathname
			? ([...sessionCacheOptions.queryKey, pathname, revision ?? 0] as const)
			: sessionCacheOptions.queryKey,
		queryFn: async ({ signal, client }) => {
			const snapshot = await probeRouteSession(
				(signal) =>
					sessionFn({ signal, headers: { "X-Mailflare-Session-Probe": "1" } }),
				{
					signal,
					isActive: () =>
						revision === undefined ||
						navigationProbes.get(client)?.revision === revision,
					server: typeof window === "undefined",
					previous: client.getQueryData<RouteSessionState>(
						sessionCacheOptions.queryKey,
					),
				},
			);
			if (signal.aborted) throw signal.reason;
			const result = { ...snapshot, checkedPath: pathname };
			if (pathname) client.setQueryData(sessionCacheOptions.queryKey, result);
			return result;
		},
	});

export async function loadRouteSession(
	client: QueryClient,
	pathname: string,
	preload = false,
) {
	if (preload)
		return (
			client.getQueryData<RouteSessionState>(sessionCacheOptions.queryKey) ?? {
				user: null,
				timeZone: null,
				transport: null,
				needsSetup: false,
				needsOnboarding: false,
				verified: false,
				fromServer: false,
			}
		);
	if (typeof window === "undefined")
		return client.fetchQuery(sessionQuery(pathname));
	const cached = client.getQueryData<RouteSessionState>(
		sessionCacheOptions.queryKey,
	);
	const active = navigationProbes.get(client);
	if (active?.path === pathname && cached && !cached.fromServer) {
		return cached.checkedPath === pathname
			? cached
			: { ...cached, verified: false };
	}
	const revision = (active?.revision ?? 0) + 1;
	navigationProbes.set(client, { path: pathname, revision });
	const pending = client.fetchQuery(sessionQuery(pathname, revision));
	if (
		cached &&
		!cached.fromServer &&
		cached.checkedPath &&
		authBoundary(cached.checkedPath) === authBoundary(pathname)
	) {
		void pending.catch(() => {});
		return { ...cached, verified: false };
	}
	return pending;
}
export const mailboxesQuery = (userId: string) =>
	queryOptions({
		queryKey: ["mailboxes", userId],
		queryFn: () => mailboxesFn(),
		staleTime: 60_000,
	});
export const messagesQuery = (userId: string, input: ListInput) =>
	queryOptions({
		queryKey: ["messages", userId, input],
		queryFn: ({ signal }) => messagesFn({ data: input, signal }),
		staleTime: 30_000,
	});
export const threadQuery = (userId: string, id: string) =>
	queryOptions({
		queryKey: ["thread", userId, id],
		queryFn: ({ signal }) => threadFn({ data: { id }, signal }),
		staleTime: 60_000,
	});
export const mailSettingsQuery = (userId: string) =>
	queryOptions({
		queryKey: ["mail-settings", userId],
		queryFn: () => mailSettingsFn(),
		staleTime: 30000,
	});
