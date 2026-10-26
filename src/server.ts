import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { publicOrigin } from "./server/config";

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
		const response = await handler.fetch(request, options);
		const headers = new Headers(response.headers);
		headers.set("Cache-Control", "private, no-store");
		headers.set("X-Content-Type-Options", "nosniff");
		headers.set("Referrer-Policy", "same-origin");
		if (!headers.has("X-Frame-Options")) headers.set("X-Frame-Options", "DENY");
		if (!headers.has("Content-Security-Policy"))
			headers.set(
				"Content-Security-Policy",
				"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
			);
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
