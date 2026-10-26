import {
	useLocation,
	useRouter as useTanStackRouter,
} from "@tanstack/react-router";
import { useContext, useMemo } from "react";
import { MailContext } from "../components/mail-context";
export function usePathname() {
	return useLocation({ select: (location) => location.pathname });
}
export function useRouter() {
	const router = useTanStackRouter(),
		mail = useContext(MailContext);
	return useMemo(() => {
		const hrefFor = (href: string) => {
			const url = new URL(href, "https://mailflare.invalid");
			if (url.origin !== "https://mailflare.invalid") return href;
			let mailboxId = mail?.mailboxId;
			try {
				const selected = localStorage.getItem("selected-mailbox-id");
				if (mail?.mailboxes.some((item) => item.id === selected))
					mailboxId = selected ?? mailboxId;
			} catch {}
			if (
				mailboxId &&
				!url.searchParams.has("mailboxId") &&
				!/^\/(c|book)(\/|$)/.test(url.pathname)
			)
				url.searchParams.set("mailboxId", mailboxId);
			return url.pathname + url.search + url.hash;
		};
		return {
			push: (href: string) => void router.navigate({ href: hrefFor(href) }),
			replace: (href: string) =>
				void router.navigate({ href: hrefFor(href), replace: true }),
			back: () => router.history.back(),
			refresh: () => void router.invalidate(),
		};
	}, [router, mail?.mailboxId, mail?.mailboxes]);
}

export function useSearchParams() {
	const search = useLocation({ select: (location) => location.searchStr });
	return useMemo(() => new URLSearchParams(search), [search]);
}
