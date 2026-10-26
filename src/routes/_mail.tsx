import { z } from "zod";
import {
	createFileRoute,
	Outlet,
	redirect,
	useLocation,
	useSearch,
} from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { MailContext } from "../components/mail-context";
import { MailClientSync } from "../components/mail-client-sync";
import { sessionQuery, mailboxesQuery } from "../queries";
import DashboardLayout from "../app/(dashboard)/layout";
import SettingsLayout from "../app/(settings)/layout";
import AdminLayout from "../app/(admin)/layout";
import CalendarLayout from "../app/(calendar)/layout";
import DriveLayout from "../app/(drive)/layout";
const adminPrefixes = [
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
	prefixes.some((prefix) => path === prefix || path.startsWith(prefix + "/"));
export const Route = createFileRoute("/_mail")({
	validateSearch: z.object({ mailboxId: z.string().optional() }),
	beforeLoad: async ({ context, location }) => {
		const session = await context.queryClient.ensureQueryData(sessionQuery());
		if (session.needsSetup) throw redirect({ to: "/setup" });
		if (!session.user) throw redirect({ to: "/login" });
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
	const search = useSearch({ strict: false });
	const { pathname } = useLocation();
	const [selected, setSelected] = useState("");
	const requested = search.mailboxId || selected;
	const mailboxId = mailboxes.some((mailbox) => mailbox.id === requested)
		? requested
		: (mailboxes[0]?.id ?? "");
	useEffect(() => {
		try {
			const stored = localStorage.getItem("selected-mailbox-id");
			if (mailboxes.some((item) => item.id === stored))
				setSelected(stored ?? "");
		} catch {}
	}, [mailboxes]);
	const select = (value: string) => {
		setSelected(value);
		try {
			localStorage.setItem("selected-mailbox-id", value);
		} catch {}
	};
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
		<MailContext.Provider
			key={user.id}
			value={{ user, mailboxes, mailboxId, setMailboxId: select }}
		>
			<MailClientSync />
			<Layout>
				<Outlet />
			</Layout>
		</MailContext.Provider>
	);
}
