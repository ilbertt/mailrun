import { QueryClient } from "@tanstack/react-query";

// Authentication is rechecked at each route transition, like the source guard.
// Document preferences have a separate lifetime and remain reusable.
export const sessionCacheOptions = {
	queryKey: ["session"] as const,
	staleTime: 0,
	retry: false,
};

export const documentCacheOptions = {
	queryKey: ["document"] as const,
	staleTime: Infinity,
	gcTime: Infinity,
};

export function createAppQueryClient() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: 1, refetchOnWindowFocus: false },
		},
	});
	// Hydration creates this query before the first client beforeLoad. Install
	// its lifetime there too, so it cannot inherit the five-minute default GC.
	client.setQueryDefaults(documentCacheOptions.queryKey, documentCacheOptions);
	return client;
}
