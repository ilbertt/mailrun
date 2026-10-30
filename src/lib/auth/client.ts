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
export const AUTH_PRINCIPAL_CHANGED_EVENT = "mailflare:principal-changed";
let sessionGeneration = 0;
let principal: string | null | undefined;
export function getClientPrincipalId() {
	return principal;
}
let verifiedTransport:
	| (ReturnType<typeof clientSessionScope> & { value: "cookie" | "bearer" })
	| null = null;

export function clientSessionScope() {
	return {
		generation: sessionGeneration,
		token: getClientSessionToken(),
		principal,
	};
}
export function isCurrentClientSession(
	scope: ReturnType<typeof clientSessionScope>,
) {
	return (
		scope.generation === sessionGeneration &&
		scope.token === getClientSessionToken() &&
		scope.principal === principal
	);
}
export function recordClientTransport(
	value: "cookie" | "bearer" | null,
	scope: ReturnType<typeof clientSessionScope>,
	userId?: string | null,
	authoritative = true,
) {
	if (!isCurrentClientSession(scope)) return;
	if (
		!authoritative &&
		verifiedTransport &&
		isCurrentClientSession(verifiedTransport)
	)
		return;
	const initial = principal === undefined;
	const changed = userId !== undefined && userId !== principal;
	if (changed) {
		principal = userId;
		if (!initial) sessionGeneration++;
		draftRevisions.clear();
		clearDriveListings();
	}
	verifiedTransport =
		value && (value === "cookie" || scope.token)
			? { ...clientSessionScope(), value }
			: null;
	if (changed && (!initial || userId !== null) && typeof window !== "undefined")
		window.dispatchEvent(
			new CustomEvent(AUTH_PRINCIPAL_CHANGED_EVENT, { detail: { initial } }),
		);
}
function cookieTransport() {
	return (
		verifiedTransport?.value === "cookie" &&
		isCurrentClientSession(verifiedTransport)
	);
}

/** Server-function calls can authenticate a stored session when cookies are unavailable. */
export async function sessionServerFetch(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	if (typeof window === "undefined") return fetch(input, init);
	const url = new URL(
		input instanceof Request ? input.url : String(input),
		window.location.href,
	);
	if (url.origin !== window.location.origin) return fetch(input, init);
	const scope = clientSessionScope();
	const response = await fetch(input, {
		...init,
		headers: getAuthHeaders(init?.headers),
	});
	if (response.status === 401) {
		await response.body?.cancel();
		throw new SessionUnauthorizedError();
	}
	const transport = response.headers.get("X-Mailflare-Session-Transport");
	if (transport === "cookie" || transport === "bearer")
		recordClientTransport(transport, scope, undefined, false);
	return response;
}

export class SessionUnauthorizedError extends Error {
	constructor() {
		super("Unauthorized");
		this.name = "SessionUnauthorizedError";
	}
}

export function getClientSessionGeneration() {
	return sessionGeneration;
}

function dispatchAuthSessionChanged(authenticated: boolean): void {
	sessionGeneration++;
	principal = undefined;
	verifiedTransport = null;
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
	const explicitAuthorization = new Headers(headers).has("Authorization");
	if (
		requestUrl.origin === window.location.origin &&
		cookieTransport() &&
		!explicitAuthorization
	)
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
	const requestGeneration = sessionGeneration;
	const requestPrincipal = principal;
	let response = await fetch(input, {
		...requestInit,
		headers: requestHeaders,
	});
	// A cookie may disappear after a successful probe. Retry only bodyless reads;
	// writes and streams choose their credential before transmission and are never replayed.
	const method = (
		requestInit.method ?? (input instanceof Request ? input.method : "GET")
	).toUpperCase();
	if (
		response.status === 401 &&
		session &&
		!requestHeaders.has("Authorization") &&
		requestUrl.origin === window.location.origin &&
		["GET", "HEAD"].includes(method) &&
		requestGeneration === sessionGeneration &&
		session === getClientSessionToken() &&
		requestPrincipal === principal
	) {
		await response.body?.cancel();
		requestHeaders.set("Authorization", "Bearer " + session);
		response = await fetch(input, { ...requestInit, headers: requestHeaders });
		if (response.ok)
			recordClientTransport("bearer", {
				generation: requestGeneration,
				token: session,
				principal: requestPrincipal,
			});
	}

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
	const currentSession =
		requestGeneration === sessionGeneration &&
		session === getClientSessionToken() &&
		requestPrincipal === principal;
	if (returnedId && revision && currentSession)
		draftRevisions.set(returnedId, revision);
	if (
		currentSession &&
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
		currentSession &&
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
