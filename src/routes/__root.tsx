import { MailNotifications } from "../components/mail-notifications";
import { BrandingProvider } from "../components/branding-provider";
import { AuthClientSync } from "../components/auth-client-sync";
import { documentQuery } from "../queries";
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
		beforeLoad: async ({ context }) => ({
			document: await context.queryClient.ensureQueryData(documentQuery()),
		}),
		loader: ({ context }) => context.document,
		head: ({ loaderData, matches }) => ({
			meta: [
				{ charSet: "utf-8" },
				{ name: "viewport", content: "width=device-width, initial-scale=1" },
				{ title: loaderData?.branding.appName ?? "Mailflare" },
				{ name: "description", content: "Multi-tenant email on Cloudflare" },
				{ name: "mobile-web-app-capable", content: "yes" },
				{
					name: "apple-mobile-web-app-title",
					content: loaderData?.branding.appName ?? "Mailflare",
				},
				{ name: "apple-mobile-web-app-status-bar-style", content: "default" },
				{
					name: "robots",
					content: "noindex, nofollow, noarchive, nosnippet, noimageindex",
				},
				{
					name: "googlebot",
					content: "noindex, nofollow, noarchive, nosnippet, noimageindex",
				},
			],
			links: [
				{ rel: "stylesheet", href: styles },
				...(matches.at(-1)?.pathname === "/"
					? [
							{
								rel: "icon",
								href: loaderData?.branding.hasCustomIcon
									? "/api/branding/icon"
									: "/icon-96.png",
							},
						]
					: [{ rel: "apple-touch-icon", href: "/icon-192.png" }]),
				{ rel: "icon", href: "/api/branding/icon" },
				{ rel: "manifest", href: "/manifest.webmanifest" },
			],
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
	const { locale, messages, branding } = Route.useLoaderData();
	return (
		<html lang={locale} dir={getDirection(locale)} suppressHydrationWarning>
			<head>
				<HeadContent />
				<script dangerouslySetInnerHTML={{ __html: sidebarBootstrapScript }} />
				<script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
			</head>
			<body className="antialiased">
				<QueryClientProvider client={queryClient}>
					<AuthClientSync />
					<LanguageProvider initialLocale={locale} initialMessages={messages}>
						<BrandingProvider initialBranding={branding}>
							<ThemeSync />
							<Outlet />
							<MailNotifications />
						</BrandingProvider>
					</LanguageProvider>
				</QueryClientProvider>
				<Scripts />
			</body>
		</html>
	);
}
