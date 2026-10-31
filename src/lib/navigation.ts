import {
	useLocation,
	useRouter as useTanStackRouter,
} from "@tanstack/react-router";
import { useMemo } from "react";
export function usePathname() {
	return useLocation({ select: (location) => location.pathname });
}
export function useRouter() {
	const router = useTanStackRouter();
	return useMemo(
		() => ({
			push: (href: string) => void router.navigate({ href }),
			replace: (href: string) => void router.navigate({ href, replace: true }),
			back: () => router.history.back(),
			refresh: () => void router.invalidate(),
		}),
		[router],
	);
}

export function useSearchParams() {
	const search = useLocation({ select: (location) => location.searchStr });
	return useMemo(() => new URLSearchParams(search), [search]);
}
