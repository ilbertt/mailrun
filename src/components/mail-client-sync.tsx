import { fetchCurrentUser } from "../hooks/use-current-user";
import { saveUserTimeZonePreference } from "../lib/time/client";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useMail } from "./mail-context";
export function MailClientSync() {
	const { user } = useMail(),
		client = useQueryClient();
	useEffect(() => {
		let active = true;
		void fetchCurrentUser().then((profile) => {
			if (active && profile?.id === user.id)
				saveUserTimeZonePreference(profile.id, profile.timeZone ?? null);
		});
		const changed = (event: Event) => {
			const path = (event as CustomEvent<{ path?: unknown }>).detail?.path;
			if (typeof path !== "string") return;
			if (
				/^\/api\/(mailboxes|domains|folders|routing-rules|settings\/profile)(?:\/|$)/.test(
					path,
				)
			) {
				void client.invalidateQueries({ queryKey: ["mailboxes", user.id] });
				void client.invalidateQueries({ queryKey: ["mail-settings", user.id] });
			}
		};
		window.addEventListener("mailflare:api-mutated", changed);
		return () => {
			active = false;
			window.removeEventListener("mailflare:api-mutated", changed);
		};
	}, [client, user.id]);
	return null;
}
