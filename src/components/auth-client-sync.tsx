import { clearCurrentUserCache } from "../hooks/use-current-user";
import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AUTH_SESSION_CHANGED_EVENT } from "../lib/auth/client";
import { clearMessageClientState } from "../hooks/utils";
import { clearMessageDetailCache } from "../lib/messages/detail-cache";
import { clearMailboxClientState } from "./mailbox-provider-utils";
import { documentQuery } from "../queries";
export function AuthClientSync() {
	const client = useQueryClient(),
		router = useRouter();
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
		const apiChanged = (event: Event) => {
			const path = (event as CustomEvent<{ path?: unknown }>).detail?.path;
			if (typeof path === "string" && /^\/api\/branding(?:\/|$)/.test(path))
				documentChanged();
		};
		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, changed);
		window.addEventListener("mailflare:locale-changed", documentChanged);
		window.addEventListener("mailflare:api-mutated", apiChanged);
		return () => {
			window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, changed);
			window.removeEventListener("mailflare:locale-changed", documentChanged);
			window.removeEventListener("mailflare:api-mutated", apiChanged);
		};
	}, [client, router]);
	return null;
}
