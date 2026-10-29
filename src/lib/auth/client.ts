import { clearDriveListings } from "../../app/(drive)/drive-cache";
("use client");

import { getUserTimeZone } from "@/lib/time/utils";
import { clearUserTimeZonePreference } from "@/lib/time/client";
import type {
	AuthFetchOptions,
	AuthSessionChangedDetail,
	AuthSessionResponse,
} from "./client-types";

const draftRevisions = new Map<string, string>();
const SESSION_STORAGE_KEY = "mailflare-session-token";
export const AUTH_SESSION_CHANGED_EVENT = "mailflare:auth-session-changed";

function dispatchAuthSessionChanged(authenticated: boolean): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(
		new CustomEvent<AuthSessionChangedDetail>(AUTH_SESSION_CHANGED_EVENT, {
			detail: { authenticated },
		}),
	);
}

export function getClientSessionToken(): string | null {
	if (typeof window === "undefined") return null;
	try {
		return localStorage.getItem(SESSION_STORAGE_KEY);
	} catch {
		return null;
	}
}

export function setClientSessionToken(token: string): void {
	draftRevisions.clear();
	clearDriveListings();
	const previousToken = getClientSessionToken();
	try {
		localStorage.setItem(SESSION_STORAGE_KEY, token);
	} catch {}
	if (previousToken !== token) clearUserTimeZonePreference();
	if (previousToken !== token) dispatchAuthSessionChanged(true);
}

export function clearClientSessionToken(): void {
	draftRevisions.clear();
	clearDriveListings();
	try {
		localStorage.removeItem(SESSION_STORAGE_KEY);
	} catch {}
	clearUserTimeZonePreference();
	dispatchAuthSessionChanged(false);
}

export function getAuthHeaders(headers?: HeadersInit): Headers {
	const nextHeaders = new Headers(headers);
	if (typeof window !== "undefined" && !nextHeaders.has("X-Time-Zone")) {
		nextHeaders.set("X-Time-Zone", getUserTimeZone());
	}
	const token = getClientSessionToken();
	if (token && !nextHeaders.has("Authorization")) {
		nextHeaders.set("Authorization", `Bearer ${token}`);
	}
	return nextHeaders;
}

export async function authFetch(
	input: RequestInfo | URL,
	init: AuthFetchOptions = {},
): Promise<Response> {
	const { redirectOnUnauthorized = true, headers, ...requestInit } = init;
	const requestHeaders = getAuthHeaders(headers);
	const requestUrl = new URL(
		input instanceof Request ? input.url : String(input),
		window.location.href,
	);
	if (requestUrl.origin === window.location.origin)
		requestHeaders.delete("Authorization");
	const draftId =
		/^\/api\/drafts\/([^/]+)/.exec(requestUrl.pathname)?.[1] ??
		(requestUrl.pathname === "/api/send" && requestInit.body instanceof FormData
			? requestInit.body.get("draftId")
			: null);
	if (
		typeof draftId === "string" &&
		draftRevisions.has(draftId) &&
		requestInit.method &&
		requestInit.method !== "GET"
	)
		requestHeaders.set("If-Match", draftRevisions.get(draftId) ?? "");
	const session = getClientSessionToken();
	const response = await fetch(input, {
		...requestInit,
		headers: requestHeaders,
	});

	const returnedId = response.headers.get("X-Mailflare-Draft-Id"),
		applicationRevision = response.headers.get("X-Mailflare-Draft-Revision"),
		// A compression proxy may weaken the representation ETag. Keep the
		// application's optimistic-lock version independent of that transformation.
		revision =
			applicationRevision !== null &&
			/^\d+$/.test(applicationRevision) &&
			Number.isSafeInteger(Number(applicationRevision))
				? `"${applicationRevision}"`
				: response.headers.get("ETag");
	if (returnedId && revision && session === getClientSessionToken())
		draftRevisions.set(returnedId, revision);
	if (
		response.ok &&
		requestInit.method &&
		!["GET", "HEAD", "OPTIONS"].includes(requestInit.method.toUpperCase())
	) {
		window.dispatchEvent(
			new CustomEvent("mailflare:api-mutated", {
				detail: { path: requestUrl.pathname },
			}),
		);
		if (/^\/api\/(messages|drafts|send)(?:\/|$)/.test(requestUrl.pathname))
			window.dispatchEvent(new Event("mailflare:messages-changed"));
	}
	if (
		response.status === 401 &&
		redirectOnUnauthorized &&
		typeof window !== "undefined"
	) {
		clearClientSessionToken();
		window.location.assign("/login");
	}

	return response;
}

export async function persistAuthSession(
	response: Response,
): Promise<AuthSessionResponse> {
	const data = (await response.json()) as AuthSessionResponse;
	if (response.ok && data.token) setClientSessionToken(data.token);
	return data;
}
