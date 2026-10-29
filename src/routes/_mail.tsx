import { z } from "zod";
import {
	createFileRoute,
	Outlet,
	redirect,
	useLocation,
} from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { MailSessionProvider } from "../components/mail-session-provider";
import { MailClientSync } from "../components/mail-client-sync";
import { sessionQuery, mailboxesQuery } from "../queries";
import DashboardLayout from "../app/(dashboard)/layout";
import SettingsLayout from "../app/(settings)/layout";
import AdminLayout from "../app/(admin)/layout";
import CalendarLayout from "../app/(calendar)/layout";
import DriveLayout from "../app/(drive)/layout";
const adminPrefixes = [
	"/admin",
	"/routing",
	"/accounts",
	"/domains",
	"/mailboxes",
	"/agent",
	"/api-keys",
	"/webhooks",
	"/backups",
	"/branding",
	"/licenses",
	"/activity",
	"/audit-logs",
	"/general",
	"/ai-usage",
];
const primaryPrefixes = [
	"/agent",
	"/api-keys",
	"/webhooks",
	"/backups",
	"/branding",
	"/licenses",
	"/activity",
	"/audit-logs",
	"/general",
	"/ai-usage",
];
const matches = (path: string, prefixes: string[]) =>
	!path.startsWith("/agent/review/") &&
	prefixes.some((prefix) => path === prefix || path.startsWith(prefix + "/"));
export const Route = createFileRoute("/_mail")({
	validateSearch: z.object({ mailboxId: z.string().optional() }),
	beforeLoad: async ({ context, location }) => {
		const session = await context.queryClient.ensureQueryData(sessionQuery());
		if (session.needsSetup) throw redirect({ to: "/setup" });
		if (!session.user) throw redirect({ to: "/login" });
		if (session.needsOnboarding && matches(location.pathname, adminPrefixes))
			throw redirect({ to: "/setup" });
		if (
			matches(location.pathname, adminPrefixes) &&
			session.user.role !== "admin"
		)
			throw redirect({ to: "/inbox" });
		if (
			matches(location.pathname, primaryPrefixes) &&
			!session.user.isPrimaryAdmin
		)
			throw redirect({ to: "/inbox" });
		return { user: session.user };
	},
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(mailboxesQuery(context.user.id)),
	component: MailLayout,
});
function MailLayout() {
	const { user } = Route.useRouteContext();
	const mailboxes = useSuspenseQuery(mailboxesQuery(user.id)).data;
	const { pathname } = useLocation();
	const Layout = matches(pathname, adminPrefixes)
		? AdminLayout
		: pathname.startsWith("/settings")
			? SettingsLayout
			: pathname.startsWith("/calendar") || pathname === "/booking"
				? CalendarLayout
				: pathname.startsWith("/drive")
					? DriveLayout
					: DashboardLayout;
	return (
		<MailSessionProvider key={user.id} user={user} mailboxes={mailboxes}>
			<MailClientSync />
			<Layout>
				<Outlet />
			</Layout>
		</MailSessionProvider>
	);
}
