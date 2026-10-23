import { localeFn } from "../functions";
import { getDirection } from "../lib/i18n/utils";
import { sidebarBootstrapScript } from "../components/sidebar-state-utils";
import { themeBootstrapScript } from "../components/theme-utils";
import {
	createRootRouteWithContext,
	HeadContent,
	Outlet,
	Scripts,
} from "@tanstack/react-router";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { LanguageProvider } from "../components/language-provider";
import { ThemeSync } from "../components/theme-sync";
import styles from "../styles.css?url";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
	{
		loader: () => localeFn(),
		head: () => ({
			meta: [
				{ charSet: "utf-8" },
				{ name: "viewport", content: "width=device-width, initial-scale=1" },
				{ title: "Mailrun" },
				{ name: "robots", content: "noindex,nofollow" },
			],
			links: [{ rel: "stylesheet", href: styles }],
		}),
		component: Root,
		notFoundComponent: () => (
			<div className="empty">
				<h1>Page not found</h1>
				<a href="/inbox">Back to mail</a>
			</div>
		),
		errorComponent: ({ error, reset }) => (
			<div className="empty" role="alert">
				<h1>Something went wrong</h1>
				<p>{error instanceof Error ? error.message : "Please try again."}</p>
				<button onClick={reset}>Try again</button>
			</div>
		),
	},
);
function Root() {
	const { queryClient } = Route.useRouteContext();
	const { locale, messages } = Route.useLoaderData();
	return (
		<html lang={locale} dir={getDirection(locale)} suppressHydrationWarning>
			<head>
				<HeadContent />
				<script dangerouslySetInnerHTML={{ __html: sidebarBootstrapScript }} />
				<script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
			</head>
			<body className="antialiased">
				<QueryClientProvider client={queryClient}>
					<LanguageProvider initialLocale={locale} initialMessages={messages}>
						<ThemeSync />
						<Outlet />
					</LanguageProvider>
				</QueryClientProvider>
				<Scripts />
			</body>
		</html>
	);
}
