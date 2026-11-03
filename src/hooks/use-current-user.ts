"use client";

import { useEffect, useState } from "react";
import {
	AUTH_SESSION_CHANGED_EVENT,
	AUTH_PRINCIPAL_CHANGED_EVENT,
	authFetch,
} from "@/lib/auth/client";

export type CurrentUser = {
	id: string;
	timeZone?: string | null;
	email: string;
	name: string;
	role: "admin" | "user";
	isPrimaryAdmin: boolean;
	canManageMailboxes: boolean;
	canManageDomains: boolean;
	canManageUsers: boolean;
	hasAvatar: boolean;
};

let generation = 0;
let cachedUser: CurrentUser | null = null;
let inflight: Promise<CurrentUser | null> | null = null;

export function clearCurrentUserCache(): void {
	generation++;
	cachedUser = null;
	inflight = null;
}

export function fetchCurrentUser(): Promise<CurrentUser | null> {
	if (cachedUser) return Promise.resolve(cachedUser);
	if (!inflight) {
		const requestGeneration = generation;
		inflight = authFetch("/api/auth/me", { redirectOnUnauthorized: false })
			.then((response) => (response.ok ? response.json() : null))
			.then((data) => {
				if (requestGeneration !== generation) return null;
				cachedUser = (data as { user?: CurrentUser } | null)?.user ?? null;
				return cachedUser;
			})
			.catch(() => null)
			.finally(() => {
				if (requestGeneration === generation) inflight = null;
			});
	}
	return inflight;
}

export function useCurrentUser(): CurrentUser | null {
	const [user, setUser] = useState<CurrentUser | null>(cachedUser);
	const [reloadKey, setReloadKey] = useState(0);

	useEffect(() => {
		let active = true;
		void fetchCurrentUser().then((next) => {
			if (active) setUser(next);
		});
		return () => {
			active = false;
		};
	}, [reloadKey]);

	// Login and logout swap the cached account without a reload, so refetch when the session changes.
	useEffect(() => {
		function onSessionChanged() {
			clearCurrentUserCache();
			setReloadKey((key) => key + 1);
		}
		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, onSessionChanged);
		window.addEventListener(AUTH_PRINCIPAL_CHANGED_EVENT, onSessionChanged);
		return () => {
			window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, onSessionChanged);
			window.removeEventListener(
				AUTH_PRINCIPAL_CHANGED_EVENT,
				onSessionChanged,
			);
		};
	}, []);

	return user;
}
