import {
	createFileRoute,
	Outlet,
	redirect,
	useRouter,
	useSearch,
} from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState, lazy, Suspense, useEffect } from "react";
import { MailContext, type ComposeIntent } from "../components/mail-context";
import { logoutFn } from "../functions";
import { sessionQuery, mailboxesQuery } from "../queries";
import { SidebarProvider } from "../components/sidebar-state";
import { SidebarAside, MobileMenuButton } from "../components/sidebar-aside";
import { SidebarResizeBoundary } from "../components/sidebar-resize-boundary";
import { DashboardNav } from "../components/dashboard-nav";
import { HeaderSearch } from "../components/header-search";
import { SkipToContent } from "../components/skip-to-content";
import { ShortcutsProvider } from "../components/shortcuts";
import { Settings } from "lucide-react";
const loadComposer = () =>
	import("../components/composer").then((module) => ({
		default: module.Composer,
	}));
const Composer = lazy(loadComposer);
export const Route = createFileRoute("/_mail")({
	beforeLoad: async ({ context }) => {
		const session = await context.queryClient.ensureQueryData(sessionQuery());
		if (session.needsSetup) throw redirect({ to: "/setup" });
		if (!session.user) throw redirect({ to: "/login" });
		return { user: session.user };
	},
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(mailboxesQuery(context.user.id)),
	component: MailLayout,
});
function MailLayout() {
	const { user, queryClient } = Route.useRouteContext();
	const router = useRouter();
	const mailboxes = useSuspenseQuery(mailboxesQuery(user.id)).data;
	const search = useSearch({ strict: false });
	const [selected, setSelected] = useState("");
	const mailboxId = search.mailboxId || selected || mailboxes[0]?.id || "";
	const [compose, setCompose] = useState<
			(ComposeIntent & { key: number }) | null
		>(null),
		[notice, setNotice] = useState("");
	const [query, setQuery] = useState(search.q ?? "");
	useEffect(() => setQuery(search.q ?? ""), [search.q]);
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
	return (
		<MailContext.Provider
			value={{
				user,
				mailboxes,
				mailboxId,
				setMailboxId: select,
				openComposer: (intent = {}) => {
					setCompose((current) =>
						current && !intent.draftId && !intent.initial
							? current
							: { ...intent, key: Date.now() },
					);
					setNotice("");
				},
			}}
		>
			<SidebarProvider mobileOverlay>
				<ShortcutsProvider>
					<div
						className="grid h-dvh grid-cols-[minmax(0,1fr)] overflow-hidden bg-[#f6f8fc] transition-[grid-template-columns] md:grid-cols-[var(--sidebar-width)_minmax(0,1fr)]"
						style={{ transitionDuration: "var(--sidebar-transition-duration)" }}
					>
						<SkipToContent />
						<SidebarAside>
							<div className="h-full">
								<DashboardNav />
							</div>
							<SidebarResizeBoundary />
						</SidebarAside>
						<div className="flex min-h-0 min-w-0 flex-col">
							<header className="flex h-16 w-full shrink-0 items-center gap-3 pr-4 text-sm">
								<MobileMenuButton className="ml-2" />
								<HeaderSearch
									value={query}
									onChange={setQuery}
									label="Search mail"
									placeholder="Search mail (press / to focus)"
									inputProps={{
										id: "mail-search",
										"data-mail-search-input": "",
									}}
									onSubmit={() =>
										void router.navigate({
											to: "/inbox",
											search: { mailboxId: mailboxId || undefined, q: query },
										})
									}
								/>
								<button
									aria-label="Settings"
									onClick={() =>
										void router.navigate({ to: "/settings/mailboxes" })
									}
									className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-200"
								>
									<Settings size={20} />
								</button>
								<select
									aria-label="Mailbox"
									className="max-w-40 bg-transparent text-sm max-md:max-w-24"
									value={mailboxId}
									onChange={(event) => {
										select(event.target.value);
										void router.navigate({
											to: "/inbox",
											search: { mailboxId: event.target.value },
										});
									}}
								>
									{mailboxes.map((item) => (
										<option key={item.id} value={item.id}>
											{item.local_part}@{item.hostname}
										</option>
									))}
								</select>
								<button
									aria-label="Sign out"
									title={`Sign out ${user.name}`}
									className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-200 font-medium text-blue-950"
									onClick={async () => {
										await logoutFn();
										queryClient.clear();
										await router.navigate({ to: "/login" });
									}}
								>
									{user.name.slice(0, 1).toUpperCase()}
								</button>
							</header>
							<div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
								<main
									id="main-content"
									tabIndex={-1}
									className="focus:outline-none min-h-0 min-w-0 flex-1 overflow-y-auto rounded-t-3xl bg-white overscroll-contain scrollbar-gutter-stable"
								>
									<Outlet />
								</main>
							</div>
						</div>
					</div>
				</ShortcutsProvider>
			</SidebarProvider>
			{notice && (
				<div
					role="status"
					className="fixed bottom-6 left-1/2 z-[70] rounded-md bg-neutral-800 px-5 py-3 text-sm text-white"
				>
					{notice}
				</div>
			)}
			{compose && (
				<Suspense
					fallback={
						<div
							role="status"
							className="fixed bottom-5 right-5 rounded-lg bg-white p-4 shadow-lg"
						>
							Opening composer…
						</div>
					}
				>
					<Composer
						key={compose.key}
						intent={compose}
						onClose={(message) => {
							setCompose(null);
							if (message) setNotice(message);
						}}
					/>
				</Suspense>
			)}
		</MailContext.Provider>
	);
}
