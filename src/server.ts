import { withSecurityHeaders } from "./server/http/security";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { publicOrigin } from "./server/config";
import { serveWithSourceContract } from "./server/http/route-contract";

export default createServerEntry({
	async fetch(request, options) {
		const started = performance.now();
		// nibrun terminates HTTPS before the guest. Use the configured public
		// origin for redirects and CSRF checks instead of trusting proxy headers.
		if (
			process.env.NIBRUN_HOSTNAME ||
			process.env.APP_URL?.startsWith("https://")
		) {
			const incoming = new URL(request.url);
			request = new Request(
				`${publicOrigin()}${incoming.pathname}${incoming.search}`,
				request,
			);
		}
		const response = await serveWithSourceContract(request, (current) =>
			handler.fetch(current, options),
		);
		const headers = new Headers(withSecurityHeaders(response).headers);
		const missingMessageAttachment =
			response.status === 404 &&
			/^\/api\/messages\/[^/]+\/attachments\/[^/]+$/.test(
				new URL(request.url).pathname,
			);
		if (!headers.has("Cache-Control") && !missingMessageAttachment)
			headers.set("Cache-Control", "private, no-store");
		headers.set(
			"Server-Timing",
			`app;dur=${(performance.now() - started).toFixed(1)}`,
		);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	},
});
