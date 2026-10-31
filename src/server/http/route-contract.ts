import source from "./source-routes.json";

export const sourceRouteContracts = Object.entries(source.routes).map(
	([path, methods]) => ({ path, methods }),
);
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const routes = sourceRouteContracts
	.map((route) => {
		const segments = route.path.split("/").slice(1);
		const pattern = segments
			.map((segment) =>
				segment.startsWith("[[...")
					? "(?:/.*)?"
					: segment.startsWith("[")
						? "/[^/]+"
						: "/" + escape(segment),
			)
			.join("");
		return {
			...route,
			pattern: new RegExp("^" + pattern + "$"),
			specificity: segments.filter((segment) => !segment.startsWith("["))
				.length,
		};
	})
	.sort(
		(a, b) => b.specificity - a.specificity || b.path.length - a.path.length,
	);

export function matchSourceRoute(pathname: string) {
	return routes.find((route) => route.pattern.test(pathname));
}

// Match Next's automatic method handling before auth/CSRF or body parsing:
// implicit HEAD runs GET, implicit OPTIONS advertises sorted methods, and
// unsupported methods return an empty 405. Explicit OPTIONS remains delegated.
export function serveWithSourceContract(
	request: Request,
	handle: (request: Request) => Response | Promise<Response>,
): Promise<Response>;
export function serveWithSourceContract(
	request: Request,
	handle: (
		request: Request,
	) => Response | undefined | Promise<Response | undefined>,
): Promise<Response | undefined>;
export async function serveWithSourceContract(
	request: Request,
	handle: (
		request: Request,
	) => Response | undefined | Promise<Response | undefined>,
) {
	const url = new URL(request.url);
	const pathname = url.pathname.replace(/\/+$/, "");
	const route = matchSourceRoute(pathname);
	if (!route) return handle(request);
	if (pathname !== url.pathname) {
		const location = pathname + url.search;
		return new Response(
			request.method === "HEAD" ? null : new TextEncoder().encode(location),
			{
				status: 308,
				headers: { Location: location, Refresh: "0;url=" + location },
			},
		);
	}
	const allowed = new Set<string>(route.methods);
	if (allowed.has("GET")) allowed.add("HEAD");
	if (!allowed.has("OPTIONS") && request.method === "OPTIONS") {
		allowed.add("OPTIONS");
		return new Response(null, {
			status: 204,
			headers: { Allow: [...allowed].sort().join(", ") },
		});
	}
	if (!allowed.has(request.method)) return new Response(null, { status: 405 });
	const isHead = request.method === "HEAD";
	// These streaming protocols already implement HEAD without creating bodies.
	const nativeHead =
		route.path === "/mcp" ||
		route.path === "/.well-known/jmap" ||
		route.path.startsWith("/jmap") ||
		route.path === "/api/export/messages";
	const response = await handle(
		isHead && !nativeHead && !route.methods.includes("HEAD")
			? new Request(request, { method: "GET" })
			: request,
	);
	if (!isHead || !response) return response;
	try {
		await response.body?.cancel();
	} catch {
		/* Preserve the handler's headers/status when its body is already closed. */
	}
	return new Response(null, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}
