// Preserve Mailflare's browser behavior across Start, native APIs and embedded
// assets. The compiled Start bundle does not need Next development's unsafe-eval.
const csp = [
	"default-src 'self'",
	"script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob: https:",
	"font-src 'self' data:",
	"connect-src 'self' ws: wss: https://challenges.cloudflare.com",
	"frame-src 'self' https://challenges.cloudflare.com",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'self'",
	"upgrade-insecure-requests",
].join("; ");
export const securityHeaders = {
	"X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet, noimageindex",
	"Content-Security-Policy": csp,
	"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "SAMEORIGIN",
	"Referrer-Policy": "strict-origin-when-cross-origin",
	"Permissions-Policy":
		"camera=(), microphone=(), geolocation=(), payment=(), usb=()",
} as const;
export function withSecurityHeaders(response: Response) {
	const headers = new Headers(response.headers);
	for (const [name, value] of Object.entries(securityHeaders))
		if (!headers.has(name)) headers.set(name, value);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
