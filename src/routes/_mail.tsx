import { z } from "zod";
import {
	createFileRoute,
	Outlet,
	redirect,
	useChildMatches,
} from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { MailSessionProvider } from "../components/mail-session-provider";
import { MailClientSync } from "../components/mail-client-sync";
import { LoadingTransition } from "../components/loading-transition";
import { sessionQuery, mailboxesQuery } from "../queries";
import DashboardLayout from "../app/(dashboard)/layout";
import SettingsLayout from "../app/(settings)/layout";
import AdminLayout from "../app/(admin)/layout";
import CalendarLayout from "../app/(calendar)/layout";
import DriveLayout from "../app/(drive)/layout";
import {
	protectedRouteAccess,
	isAdminMailRoute,
} from "../lib/auth/route-access";
export const Route = createFileRoute("/_mail")({
	validateSearch: z.object({ mailboxId: z.string().optional() }),
	beforeLoad: async ({ context, location }) => {
		const session = await context.queryClient.fetchQuery(sessionQuery());
		const access = protectedRouteAccess(session, location.pathname);
		if ("redirect" in access) throw redirect({ to: access.redirect });
		return { ...access, timeZone: session.timeZone };
	},
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(mailboxesQuery(context.user.id)),
	component: MailLayout,
});
function MailLayout() {
	const { user, timeZone } = Route.useRouteContext();
	const mailboxes = useSuspenseQuery(mailboxesQuery(user.id)).data;
	const pathname = useChildMatches({
		select: (matches) => matches.at(-1)?.pathname ?? "/inbox",
	});
	const Layout = isAdminMailRoute(pathname)
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
			<LoadingTransition ready>
				<MailClientSync timeZone={timeZone} />
				<Layout>
					<Outlet />
				</Layout>
			</LoadingTransition>
		</MailSessionProvider>
	);
}
