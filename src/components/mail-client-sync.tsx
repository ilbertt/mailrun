import { saveUserTimeZonePreference } from "../lib/time/client";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useMail } from "./mail-context";
export function MailClientSync({ timeZone }: { timeZone: string | null }) {
	const { user, scopeId } = useMail(),
		client = useQueryClient();
	useEffect(() => {
		if (user) saveUserTimeZonePreference(user.id, timeZone);
	}, [user?.id, timeZone]);
	useEffect(() => {
		const changed = (event: Event) => {
			const path = (event as CustomEvent<{ path?: unknown }>).detail?.path;
			if (typeof path !== "string") return;
			if (
				/^\/api\/(mailboxes|domains|folders|routing-rules|settings\/profile)(?:\/|$)/.test(
					path,
				)
			) {
				void client.invalidateQueries({ queryKey: ["mailboxes", scopeId] });
				void client.invalidateQueries({ queryKey: ["mail-settings", scopeId] });
			}
		};
		window.addEventListener("mailflare:api-mutated", changed);
		return () => {
			window.removeEventListener("mailflare:api-mutated", changed);
		};
	}, [client, scopeId]);
	return null;
}
