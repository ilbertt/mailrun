import { clearCurrentUserCache } from "../hooks/use-current-user";
import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AUTH_SESSION_CHANGED_EVENT } from "../lib/auth/client";
import { clearMessageClientState } from "../hooks/utils";
import { clearMessageDetailCache } from "../lib/messages/detail-cache";
import { clearMailboxClientState } from "./mailbox-provider-utils";
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
		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, changed);
		return () =>
			window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, changed);
	}, [client, router]);
	return null;
}
