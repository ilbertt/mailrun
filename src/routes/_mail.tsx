import { createFileRoute, Link, Outlet, redirect, useRouter } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { logoutFn } from "../functions";
import { sessionQuery, mailboxesQuery } from "../queries";
import type { Folder } from "../shared/contracts";

export const Route = createFileRoute("/_mail")({
	beforeLoad: async ({ context }) => {
		const session = await context.queryClient.ensureQueryData(sessionQuery());
		if (session.needsSetup) throw redirect({ to: "/setup" });
		if (!session.user) throw redirect({ to: "/login" });
		return { user: session.user };
	},
	loader: ({ context }) => context.queryClient.ensureQueryData(mailboxesQuery(context.user.id)),
	component: MailLayout,
});
const folders: Array<{ id: Folder; label: string; icon: string }> = [
	{ id: "inbox", label: "Inbox", icon: "▣" }, { id: "starred", label: "Starred", icon: "☆" },
	{ id: "sent", label: "Sent", icon: "↗" }, { id: "drafts", label: "Drafts", icon: "▤" },
	{ id: "archived", label: "Archive", icon: "▧" }, { id: "spam", label: "Spam", icon: "⊘" },
	{ id: "trash", label: "Trash", icon: "⌫" },
];
function MailLayout() {
	const { user, queryClient } = Route.useRouteContext();
	const router = useRouter();
	const mailboxes = useSuspenseQuery(mailboxesQuery(user.id)).data;
	return <div className="app-shell">
		<aside className="sidebar"><Link className="brand" to="/inbox">✉ Mailrun</Link>
			<nav aria-label="Mail folders">{folders.map(folder => <Link key={folder.id} to="/inbox" search={{ folder: folder.id }} activeOptions={{ exact: false, includeSearch: true }}><span>{folder.icon}</span>{folder.label}</Link>)}</nav>
			<div className="sidebar-footer"><span>{mailboxes.length} mailbox{mailboxes.length === 1 ? "" : "es"}</span>
				{user.isPrimaryAdmin && <Link to="/setup">Connect email</Link>}
				<a href="https://github.com/ilbertt/mailrun">Source code</a>
			</div>
		</aside>
		<div className="workspace"><header className="topbar"><span>{user.name}</span><button onClick={async () => { await logoutFn(); queryClient.clear(); await router.navigate({ to: "/login" }); }}>Sign out</button></header><Outlet /></div>
	</div>;
}
