import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import styles from "../styles.css?url";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
	head: () => ({
		meta: [{ charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" }, { title: "Mailrun" }, { name: "robots", content: "noindex,nofollow" }],
		links: [{ rel: "stylesheet", href: styles }],
	}),
	component: Root,
	notFoundComponent: () => <div className="empty"><h1>Page not found</h1><a href="/inbox">Back to mail</a></div>,
	errorComponent: ({ error, reset }) => <div className="empty" role="alert"><h1>Something went wrong</h1><p>{error instanceof Error ? error.message : "Please try again."}</p><button onClick={reset}>Try again</button></div>,
});
function Root() {
	const { queryClient } = Route.useRouteContext();
	return <html lang="en"><head><HeadContent /></head><body><QueryClientProvider client={queryClient}><Outlet /></QueryClientProvider><Scripts /></body></html>;
}
