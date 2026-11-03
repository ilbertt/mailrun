import { clearCurrentUserCache } from "../hooks/use-current-user";
import { useEffect } from "react";
import { useRouter, useLocation } from "@tanstack/react-router";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import {
	AUTH_SESSION_CHANGED_EVENT,
	AUTH_PRINCIPAL_CHANGED_EVENT,
} from "../lib/auth/client";
import { clearMessageClientState } from "../hooks/utils";
import { clearMessageDetailCache } from "../lib/messages/detail-cache";
import {
	clearMailboxClientState,
	clearMailboxesCache,
} from "./mailbox-provider-utils";
import { documentQuery, sessionQuery } from "../queries";
import { sessionCacheOptions } from "../query-client";
import type { RouteSessionState } from "../lib/auth/route-probe";
export function AuthClientSync() {
	const client = useQueryClient(),
		router = useRouter();
	const pathname = useLocation({ select: (location) => location.pathname });
	const { data: checkedSession } = useQuery({
		...sessionQuery(),
		enabled: false,
	});
	useEffect(() => {
		if (
			checkedSession &&
			!checkedSession.fromServer &&
			checkedSession.checkedPath === pathname
		)
			void router.invalidate();
	}, [checkedSession, pathname, router]);
	useEffect(() => {
		if (
			["/login", "/forgot-password", "/reset-password"].includes(pathname) &&
			client.getQueryData<RouteSessionState>(sessionCacheOptions.queryKey)
				?.fromServer
		)
			void router.invalidate();
	}, [pathname, client, router]);
	useEffect(() => {
		const changed = () => {
			clearCurrentUserCache();
			clearMessageClientState();
			clearMessageDetailCache();
			clearMailboxClientState();
			client.clear();
			void router.invalidate();
		};
		const documentChanged = () => {
			client.removeQueries({ queryKey: documentQuery().queryKey });
			void router.invalidate();
		};
		const principalChanged = (event: Event) => {
			clearCurrentUserCache();
			clearMessageClientState();
			clearMessageDetailCache();
			if ((event as CustomEvent<{ initial?: boolean }>).detail?.initial)
				clearMailboxesCache();
			else clearMailboxClientState();
			client.removeQueries({
				predicate: (query) =>
					query.queryKey[0] !== "session" && query.queryKey[0] !== "document",
			});
		};
		const apiChanged = (event: Event) => {
			const path = (event as CustomEvent<{ path?: unknown }>).detail?.path;
			if (typeof path === "string" && /^\/api\/branding(?:\/|$)/.test(path))
				documentChanged();
		};
		const timeZoneChanged = (event: StorageEvent) => {
			if (event.key === "mailflare-user-time-zone") window.location.reload();
		};
		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, changed);
		window.addEventListener(AUTH_PRINCIPAL_CHANGED_EVENT, principalChanged);
		window.addEventListener("mailflare:locale-changed", documentChanged);
		window.addEventListener("mailflare:api-mutated", apiChanged);
		window.addEventListener("storage", timeZoneChanged);
		return () => {
			window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, changed);
			window.removeEventListener(
				AUTH_PRINCIPAL_CHANGED_EVENT,
				principalChanged,
			);
			window.removeEventListener("mailflare:locale-changed", documentChanged);
			window.removeEventListener("mailflare:api-mutated", apiChanged);
			window.removeEventListener("storage", timeZoneChanged);
		};
	}, [client, router]);
	return null;
}
