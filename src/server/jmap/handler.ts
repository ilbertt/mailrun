import { authenticateApiKey, hasScope } from "../auth/api-key";
import { apiKeyPrincipal, assertApiPrincipal } from "../auth/key-principal";
import { publicOrigin } from "../config";
import { withDatabase } from "../db";
import { readLimitedBody } from "../mail/inbound";
import { LIMITS } from "./constants";
import { corsHeaders, JmapError, problemResponse } from "./errors";
import { readBlob, storeUpload } from "./blobs";
import { processRequest, sessionState, validateRequest } from "./processor";
import { buildSession } from "./session";
import { getEmailState, getMailboxState } from "./state";
import type { JmapContext } from "./types";
import type { CloudflareFetch } from "../cloudflare/client";
const JSON_HEADERS = {
	"Content-Type": "application/json; charset=utf-8",
	"Cache-Control": "no-store",
	...corsHeaders(),
};
export const isJmapPath = (path: string) =>
	path === "/jmap" || path.startsWith("/jmap/") || path === "/.well-known/jmap";
export async function handleJmapRequest(
	request: Request,
	send?: CloudflareFetch,
	onAuthenticatedLongRequest?: () => void,
): Promise<Response> {
	const url = new URL(request.url),
		path = url.pathname;
	if (request.method === "OPTIONS")
		return new Response(null, { status: 204, headers: corsHeaders() });
	if (path === "/.well-known/jmap")
		return Response.redirect(`${publicOrigin()}/jmap/session`, 301);
	if (path === "/jmap") return new Response("Not found", { status: 404 });
	const key = await authenticateApiKey(request);
	if (!key)
		return new Response(JSON.stringify({ error: "Unauthorized" }), {
			status: 401,
			headers: {
				...JSON_HEADERS,
				"WWW-Authenticate": 'Basic realm="Mailflare JMAP", Bearer',
			},
		});
	if (!hasScope(key, "jmap"))
		return new Response(
			JSON.stringify({ error: "This API key does not have the jmap scope" }),
			{ status: 403, headers: JSON_HEADERS },
		);
	// Batched submissions can legitimately exceed Bun's normal HTTP idle limit.
	if (path === "/jmap/api" || path === "/jmap/eventsource")
		onAuthenticatedLongRequest?.();
	const ctx: JmapContext = {
		auth: { ...key, userId: key.user.id, email: key.user.email },
		actor: apiKeyPrincipal(key, "jmap"),
		accountId: key.user.id,
		origin: publicOrigin(),
		createdIds: Object.create(null) as Record<string, string>,
		send,
	};
	try {
		if (path === "/jmap/session" && ["GET", "HEAD"].includes(request.method))
			return new Response(
				request.method === "HEAD"
					? null
					: JSON.stringify(buildSession(ctx, await sessionState(ctx))),
				{ headers: JSON_HEADERS },
			);
		if (path === "/jmap/api" && request.method === "POST") {
			let body: unknown;
			try {
				body = JSON.parse(
					new TextDecoder().decode(
						await readLimitedBody(request, LIMITS.maxSizeRequest),
					),
				);
			} catch (error) {
				return error instanceof Error && error.message === "Message too large"
					? problemResponse("limit", 400, "Request too large", {
							limit: "maxSizeRequest",
						})
					: problemResponse("notJSON", 400, "Body is not valid JSON");
			}
			try {
				return new Response(
					JSON.stringify(await processRequest(ctx, validateRequest(body))),
					{ headers: JSON_HEADERS },
				);
			} catch (error) {
				if (error instanceof JmapError)
					return problemResponse(error.type, 400, error.message, error.extra);
				throw error;
			}
		}
		const download = /^\/jmap\/download\/([^/]+)\/([^/]+)\/(.*)$/.exec(path);
		if (download && ["GET", "HEAD"].includes(request.method)) {
			if (decodeURIComponent(download[1]!) !== ctx.accountId)
				return new Response("Not found", {
					status: 404,
					headers: corsHeaders(),
				});
			const blob = await readBlob(ctx, decodeURIComponent(download[2]!));
			if (!blob)
				return new Response("Not found", {
					status: 404,
					headers: corsHeaders(),
				});
			const name = decodeURIComponent(download[3]!) || blob.name || "blob",
				type = url.searchParams.get("type") || blob.type;
			return new Response(request.method === "HEAD" ? null : blob.body, {
				headers: {
					"Content-Type": type,
					"Content-Length": String(blob.size),
					"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
					"Cache-Control": "private, max-age=3600",
					"Content-Security-Policy": "default-src 'none'; sandbox",
					...corsHeaders(),
				},
			});
		}
		const upload = /^\/jmap\/upload\/([^/]+)$/.exec(path);
		if (upload && request.method === "POST") {
			if (decodeURIComponent(upload[1]!) !== ctx.accountId)
				return problemResponse("accountNotFound", 404, "Unknown account");
			let bytes: Uint8Array<ArrayBuffer>;
			try {
				bytes = await readLimitedBody(request, LIMITS.maxSizeUpload);
			} catch {
				return problemResponse("limit", 413, "Upload too large", {
					limit: "maxSizeUpload",
				});
			}
			const type =
					request.headers.get("content-type") || "application/octet-stream",
				disposition = request.headers.get("content-disposition") ?? "",
				name =
					disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1] ??
					null;
			const stored = await storeUpload(
				ctx,
				bytes.buffer,
				type,
				name ? decodeURIComponent(name) : null,
			);
			return new Response(JSON.stringify(stored), {
				status: 201,
				headers: JSON_HEADERS,
			});
		}
		if (path === "/jmap/eventsource" && request.method === "GET")
			return eventSource(ctx, url, request.signal);
		return new Response(JSON.stringify({ error: "Not found" }), {
			status: 404,
			headers: JSON_HEADERS,
		});
	} catch (error) {
		if (error instanceof URIError)
			return problemResponse("invalidArguments", 400, "Invalid URL encoding");
		if (error instanceof Response)
			return new Response(JSON.stringify({ error: await error.text() }), {
				status: error.status,
				headers: JSON_HEADERS,
			});
		console.error("JMAP HTTP request failed", error);
		return problemResponse("serverFail", 500, "Request failed");
	}
}
function eventSource(ctx: JmapContext, url: URL, signal: AbortSignal) {
	const value = Number(url.searchParams.get("ping") || 30),
		// Larger delays overflow setTimeout to a busy one-millisecond loop.
		ping = Number.isFinite(value)
			? Math.min(Math.max(value, 10), 2_147_483)
			: 30,
		closeAfter = url.searchParams.get("closeafter") === "state",
		encoder = new TextEncoder();
	let last = "",
		timer: ReturnType<typeof setTimeout> | undefined,
		stopped = false;
	let removeAbortListener = () => {};
	const stop = () => {
		stopped = true;
		clearTimeout(timer);
		removeAbortListener();
	};
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const abort = () => {
				if (!stopped) {
					stop();
					controller.close();
				}
			};
			removeAbortListener = () => signal.removeEventListener("abort", abort);
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) {
				abort();
				return;
			}
			const emit = async () => {
				try {
					await withDatabase((sql) => assertApiPrincipal(sql, ctx.actor));
					const email = await getEmailState(ctx),
						mailbox = await getMailboxState(ctx, email);
					if (stopped) return;
					const state = `${mailbox}|${email}`;
					if (state === last)
						controller.enqueue(
							encoder.encode(`event: ping\ndata: {"interval": ${ping}}\n\n`),
						);
					else {
						last = state;
						controller.enqueue(
							encoder.encode(
								`event: state\ndata: ${JSON.stringify({ "@type": "StateChange", changed: { [ctx.accountId]: { Mailbox: mailbox, Email: email, Thread: email } } })}\n\n`,
							),
						);
						if (closeAfter) {
							stop();
							controller.close();
							signal.removeEventListener("abort", abort);
						}
					}
					if (!stopped) timer = setTimeout(() => void emit(), ping * 1000);
				} catch {
					if (!stopped) {
						stop();
						controller.close();
					}
					signal.removeEventListener("abort", abort);
				}
			};
			void emit();
		},
		cancel() {
			stop();
		},
	});
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-store",
			Connection: "keep-alive",
			...corsHeaders(),
		},
	});
}
