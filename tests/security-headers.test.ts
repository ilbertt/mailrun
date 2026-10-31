import { test, expect } from "bun:test";
import {
	securityHeaders,
	withSecurityHeaders,
} from "../src/server/http/security";
import { getAssetRoutes } from "../src/server/assets";

test("page policy permits the original Turnstile, same-origin frames, WebSockets and workers without dynamic evaluation", () => {
	const directives = new Map(
		securityHeaders["Content-Security-Policy"].split("; ").map((value) => {
			const [name, ...sources] = value.split(" ");
			return [name, sources];
		}),
	);
	for (const name of ["script-src", "frame-src", "connect-src"])
		expect(directives.get(name)).toContain("https://challenges.cloudflare.com");
	expect(directives.get("frame-ancestors")).toEqual(["'self'"]);
	expect(directives.get("connect-src")).toContain("wss:");
	expect(directives.get("script-src")).toContain("'self'");
	expect(directives.get("script-src")).not.toContain("'unsafe-eval'");
});
test("security defaults preserve file sandbox, cache, range, conditional and cookie headers", async () => {
	const response = withSecurityHeaders(
		new Response(new Uint8Array([1, 2, 3]), {
			status: 206,
			headers: {
				"Content-Security-Policy": "default-src 'none'; sandbox",
				"Cache-Control": "private, max-age=31536000, immutable",
				"Content-Range": "bytes 0-2/8",
				ETag: '"avatar"',
				"Set-Cookie": "synthetic=true",
			},
		}),
	);
	expect(response.status).toBe(206);
	expect(response.headers.get("Content-Security-Policy")).toBe(
		"default-src 'none'; sandbox",
	);
	expect(response.headers.get("Cache-Control")).toBe(
		"private, max-age=31536000, immutable",
	);
	expect(response.headers.get("Content-Range")).toBe("bytes 0-2/8");
	expect(response.headers.get("Set-Cookie")).toBe("synthetic=true");
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(
		new Uint8Array([1, 2, 3]),
	);
	const conditional = withSecurityHeaders(
		new Response(null, { status: 304, headers: { ETag: '"avatar"' } }),
	);
	expect(conditional.status).toBe(304);
	expect(conditional.body).toBeNull();
});
test("embedded assets carry security headers while retaining their original caching policy", () => {
	const routes = getAssetRoutes(),
		entry =
			Object.entries(routes).find(([path]) => path.startsWith("/assets/")) ??
			Object.entries(routes)[0];
	if (!entry) throw new Error("No embedded/public asset fixture");
	const [path, response] = entry;
	expect(response.headers.get("X-Robots-Tag")).toBe(
		securityHeaders["X-Robots-Tag"],
	);
	expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
	expect(response.headers.get("Cache-Control")).toBe(
		path.startsWith("/assets/")
			? "public, max-age=31536000, immutable"
			: "no-cache",
	);
});
