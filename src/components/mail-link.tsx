import { useEffect, useRef, type ComponentProps } from "react";
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
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const internal =
		href.startsWith("/") &&
		!href.startsWith("//") &&
		!href.startsWith("/\\") &&
		(props.target == null || props.target === "_self") &&
		props.download == null;
	const cancelPreload = () => {
		clearTimeout(timer.current);
		timer.current = undefined;
	};
	useEffect(() => cancelPreload, [href, internal, prefetch, router]);
	const preload = (delay = 0) => {
		if (!internal || prefetch === false || timer.current !== undefined) return;
		const run = () => {
			timer.current = undefined;
			void router.preloadRoute({ to: href, href }).catch(() => {
				// Speculation must not interfere with ordinary link navigation.
			});
		};
		if (delay) timer.current = setTimeout(run, delay);
		else run();
	};
	return (
		<a
			{...props}
			href={href}
			onMouseEnter={(event) => {
				props.onMouseEnter?.(event);
				if (!event.defaultPrevented)
					preload(router.options.defaultPreloadDelay ?? 50);
			}}
			onMouseLeave={(event) => {
				props.onMouseLeave?.(event);
				cancelPreload();
			}}
			onFocus={(event) => {
				props.onFocus?.(event);
				if (!event.defaultPrevented) preload();
			}}
			onBlur={(event) => {
				props.onBlur?.(event);
				cancelPreload();
			}}
			onTouchStart={(event) => {
				props.onTouchStart?.(event);
				if (!event.defaultPrevented) preload();
			}}
			onClick={(event) => {
				cancelPreload();
				onClick?.(event);
				if (
					event.defaultPrevented ||
					event.button !== 0 ||
					event.metaKey ||
					event.ctrlKey ||
					event.altKey ||
					event.shiftKey ||
					!internal
				)
					return;
				event.preventDefault();
				void router.navigate({ href, replace, resetScroll: scroll });
			}}
		/>
	);
}
