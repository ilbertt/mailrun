import { publicOrigin } from "../config";
import { authenticateMcpRequest } from "./auth";
import { allowAgentRequest } from "../agent/rate-limit";
export async function handleMcpRequest(
	request: Request,
	onAuthenticated?: () => void,
) {
	if (request.method === "OPTIONS")
		return new Response(null, {
			status: 204,
			headers: { Allow: "DELETE, GET, HEAD, OPTIONS, POST" },
		});
	if (!["GET", "HEAD", "POST", "DELETE"].includes(request.method))
		return new Response("Method not allowed", {
			status: 405,
			headers: { Allow: "GET, HEAD, POST, DELETE, OPTIONS" },
		});
	const url = new URL(request.url),
		origin = request.headers.get("origin"),
		base = publicOrigin();
	if (origin && origin !== base)
		return new Response("Invalid origin", { status: 403 });
	if (
		(process.env.APP_URL || process.env.NIBRUN_HOSTNAME) &&
		url.host !== new URL(base).host
	)
		return new Response("Invalid host", { status: 403 });
	const principal = await authenticateMcpRequest(request);
	if (!principal)
		return new Response("Unauthorized", {
			status: 401,
			headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" },
		});
	if (!allowAgentRequest(`mcp:${principal.keyId}`))
		return new Response("Rate limit exceeded", { status: 429 });
	onAuthenticated?.();
	// Start and the native entrypoint have separate bundles. Load the SDK only
	// for a protocol request, so ordinary SSR does not initialize a second copy.
	const { createMailflareMcpHandler } = await import("./server");
	const handler = createMailflareMcpHandler(
		principal,
		base,
		request.headers.get("authorization") ?? "",
	);
	// The SDK installs abort listeners that retain its per-request server. Give
	// them a response-scoped signal, and release them on completion/cancellation
	// even when the client keeps its HTTP connection alive.
	const scope = new AbortController();
	const abort = () => scope.abort(request.signal.reason);
	request.signal.addEventListener("abort", abort, { once: true });
	if (request.signal.aborted) abort();
	let closing: Promise<void> | undefined;
	const finish = () => {
		if (closing) return closing;
		request.signal.removeEventListener("abort", abort);
		scope.abort();
		return (closing = handler.close());
	};
	try {
		const response = await handler.fetch(
			new Request(request, { signal: scope.signal }),
		);
		// Preserve the source stateless handler lifetime; the response-scoped
		// abort signal remains alive until its body is drained or cancelled.
		await handler.close();
		if (!response.body || request.method === "HEAD") {
			await response.body?.cancel();
			await finish();
			return new Response(null, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		}
		const reader = response.body.getReader();
		return new Response(
			new ReadableStream<Uint8Array>({
				async pull(controller) {
					try {
						const { done, value } = await reader.read();
						if (done) {
							await finish();
							controller.close();
						} else controller.enqueue(value);
					} catch (error) {
						await finish();
						controller.error(error);
					}
				},
				async cancel(reason) {
					try {
						await reader.cancel(reason);
					} finally {
						await finish();
					}
				},
			}),
			{
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			},
		);
	} catch (error) {
		await finish();
		throw error;
	}
}
