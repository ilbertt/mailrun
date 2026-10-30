import {
	authFetch,
	getClientSessionToken,
	getClientSessionGeneration,
	getClientPrincipalId,
} from "@/lib/auth/client";
import type { Message } from "@/hooks/types";
import type { CachedMessageDetail } from "./detail-cache-types";

const detailCache = new Map<string, CachedMessageDetail>();
const detailRequests = new Map<string, Promise<CachedMessageDetail>>();
let detailGeneration = 0;
let cacheSessionGeneration = getClientSessionGeneration();
let cacheSessionToken = getClientSessionToken();
let cachePrincipal = getClientPrincipalId();

export function clearMessageDetailCache() {
	detailGeneration++;
	cacheSessionGeneration = getClientSessionGeneration();
	cacheSessionToken = getClientSessionToken();
	cachePrincipal = getClientPrincipalId();
	detailCache.clear();
	detailRequests.clear();
}

function syncSession() {
	if (
		cacheSessionGeneration !== getClientSessionGeneration() ||
		cacheSessionToken !== getClientSessionToken() ||
		cachePrincipal !== getClientPrincipalId()
	)
		clearMessageDetailCache();
}

export function getCachedMessageDetail(
	messageId: string,
): CachedMessageDetail | undefined {
	syncSession();
	return detailCache.get(messageId);
}

export function setCachedMessageRead(messageId: string, read: boolean): void {
	syncSession();
	const cached = detailCache.get(messageId);
	if (cached?.message)
		detailCache.set(messageId, {
			...cached,
			message: { ...cached.message, read },
		});
}

export function primeMessageDetail(message: Message): void {
	syncSession();
	if (message.textBody === undefined && message.htmlBody === undefined) return;
	detailCache.set(message.id, {
		message,
		body: {
			textBody: message.textBody ?? null,
			htmlBody: message.htmlBody ?? null,
		},
	});
}

export async function fetchCachedMessageDetail(
	messageId: string,
	force = false,
): Promise<CachedMessageDetail> {
	syncSession();
	if (!force && detailCache.has(messageId))
		return detailCache.get(messageId) ?? {};
	if (!force && detailRequests.has(messageId))
		return detailRequests.get(messageId) ?? {};
	const requestGeneration = detailGeneration;
	const request = authFetch(`/api/messages/${messageId}`)
		.then((response) => response.json() as Promise<CachedMessageDetail>)
		.then((data) => {
			syncSession();
			if (requestGeneration !== detailGeneration) return {};
			if (detailRequests.get(messageId) === request)
				detailCache.set(messageId, data);
			return data;
		})
		.finally(() => {
			if (detailRequests.get(messageId) === request)
				detailRequests.delete(messageId);
		});
	detailRequests.set(messageId, request);
	return request;
}
