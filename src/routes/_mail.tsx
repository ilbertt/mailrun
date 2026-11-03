import { z } from "zod";
import {
	createFileRoute,
	Outlet,
	redirect,
	useChildMatches,
	useRouter,
} from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { getClientSessionGeneration } from "../lib/auth/client";
import { MailSessionProvider } from "../components/mail-session-provider";
import { MailClientSync } from "../components/mail-client-sync";
import { LoadingTransition } from "../components/loading-transition";
import { loadRouteSession, mailboxesQuery } from "../queries";
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
	beforeLoad: async ({ context, location, preload }) => {
		const session = await loadRouteSession(
			context.queryClient,
			location.pathname,
			preload,
		);
		if (!preload && !session.fromServer && session.verified) {
			const access = protectedRouteAccess(session, location.pathname);
			if ("redirect" in access) throw redirect({ to: access.redirect });
		}
		return {
			user: session.user,
			timeZone: session.timeZone,
			fromServer: session.fromServer,
			verified: session.verified,
		};
	},
	component: MailLayout,
});
function MailLayout() {
	const { user, timeZone, fromServer } = Route.useRouteContext();
	const router = useRouter();
	useEffect(() => {
		if (fromServer) void router.invalidate();
	}, [fromServer, router]);
	const scopeId = user?.id ?? `unverified:${getClientSessionGeneration()}`;
	const mailboxQuery = useQuery({
		...mailboxesQuery(scopeId),
		enabled: !fromServer,
	});
	const mailboxes = mailboxQuery.data ?? [];
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
		<LoadingTransition ready={!fromServer}>
			<MailSessionProvider
				key={scopeId}
				user={user}
				scopeId={scopeId}
				mailboxesLoading={mailboxQuery.isPending && mailboxQuery.isFetching}
				mailboxes={mailboxes}
			>
				<MailClientSync timeZone={timeZone} />
				<Layout>
					<Outlet />
				</Layout>
			</MailSessionProvider>
		</LoadingTransition>
	);
}
