import type { ComponentProps } from "react";
import { useRouter } from "@tanstack/react-router";
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
	return (
		<a
			{...props}
			href={href}
			onClick={(event) => {
				onClick?.(event);
				if (
					event.defaultPrevented ||
					event.button !== 0 ||
					event.metaKey ||
					event.ctrlKey ||
					event.altKey ||
					event.shiftKey ||
					(props.target != null && props.target !== "_self") ||
					props.download != null ||
					!href.startsWith("/") ||
					href.startsWith("//")
				)
					return;
				event.preventDefault();
				void router.navigate({ href, replace, resetScroll: scroll });
			}}
		/>
	);
}
