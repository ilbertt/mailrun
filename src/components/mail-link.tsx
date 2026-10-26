import { useContext, type ComponentProps } from "react";
import { useRouter } from "@tanstack/react-router";
import { MailContext } from "./mail-context";
export function MailLink({
	href,
	onClick,
	prefetch,
	replace,
	scroll,
	...props
}: ComponentProps<"a"> & {
	href: string;
	prefetch?: boolean;
	replace?: boolean;
	scroll?: boolean;
}) {
	const router = useRouter();
	const mailboxId = useContext(MailContext)?.mailboxId;
	const url = new URL(href, "https://mailflare.invalid");
	if (mailboxId && url.origin === "https://mailflare.invalid")
		url.searchParams.set("mailboxId", mailboxId);
	const target =
		url.origin === "https://mailflare.invalid"
			? url.pathname + url.search + url.hash
			: href;
	return (
		<a
			{...props}
			href={target}
			onClick={(event) => {
				onClick?.(event);
				if (
					event.defaultPrevented ||
					event.button !== 0 ||
					event.metaKey ||
					event.ctrlKey ||
					event.altKey ||
					event.shiftKey ||
					props.target === "_blank" ||
					url.origin !== "https://mailflare.invalid"
				)
					return;
				event.preventDefault();
				void router.navigate({ href: target, replace, resetScroll: scroll });
			}}
		/>
	);
}
