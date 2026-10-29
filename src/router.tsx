import { createRouter } from "@tanstack/react-router";
import { createAppQueryClient } from "./query-client";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { routeTree } from "./routeTree.gen";
import { parseRouteSearch, stringifyRouteSearch } from "./lib/router-search";

export function getRouter() {
	const queryClient = createAppQueryClient();
	const router = createRouter({
		routeTree,
		context: { queryClient },
		defaultPreload: "intent",
		defaultPreloadStaleTime: 0,
		parseSearch: parseRouteSearch,
		stringifySearch: stringifyRouteSearch,
		scrollRestoration: true,
	});
	setupRouterSsrQueryIntegration({
		router,
		queryClient,
		wrapQueryClient: false,
	});
	return router;
}
declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
