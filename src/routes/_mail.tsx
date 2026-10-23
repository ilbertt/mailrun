import {
	createFileRoute,
	Link,
	Outlet,
	redirect,
	useRouter,
} from "@tanstack/react-router";
import { useQuery, useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { useState, lazy, Suspense } from "react";
import { useLocation, useSearch } from "@tanstack/react-router";
import {
	Archive,
	Clock,
	FileText,
	Inbox,
	MailPlus,
	Menu,
	Search,
	Send,
	ShieldAlert,
	Star,
	Trash2,
	Settings,
	Folder as FolderIcon,
	Plus,
	CalendarClock,
	ChevronDown,
	ChevronUp,
} from "lucide-react";
import { MailContext, type ComposeIntent } from "../components/mail-context";
const loadComposer = () =>
	import("../components/composer").then((module) => ({
		default: module.Composer,
	}));
const Composer = lazy(loadComposer);
import { logoutFn, mailCountsFn, createFolderFn } from "../functions";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { sessionQuery, mailboxesQuery, mailSettingsQuery } from "../queries";
import type { Folder } from "../shared/contracts";

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
const folders = [
	{ id: "inbox", label: "Inbox", icon: Inbox },
	{ id: "starred", label: "Starred", icon: Star },
	{ id: "snoozed", label: "Snoozed", icon: Clock },
	{ id: "sent", label: "Sent", icon: Send },
	{ id: "scheduled", label: "Scheduled", icon: CalendarClock },
	{ id: "drafts", label: "Drafts", icon: FileText },
	{ id: "archived", label: "Archived", icon: Archive },
	{ id: "spam", label: "Spam", icon: ShieldAlert },
	{ id: "trash", label: "Trash", icon: Trash2 },
] satisfies Array<{ id: Folder; label: string; icon: typeof Inbox }>;
function MailLayout() {
	const { user, queryClient } = Route.useRouteContext();
	const router = useRouter();
	const mailboxes = useSuspenseQuery(mailboxesQuery(user.id)).data;
	const search = useSearch({ strict: false });
	const pathname = useLocation({ select: (location) => location.pathname });
	const [selected, setSelected] = useState("");
	const mailboxId = search.mailboxId ?? selected ?? mailboxes[0]?.id ?? "";
	const effectiveMailbox = mailboxId || mailboxes[0]?.id || "";
	const [compose, setCompose] = useState<
			(ComposeIntent & { key: number }) | null
		>(null),
		[notice, setNotice] = useState("");
	const [minimal, setMinimal] = useState(false),
		[more, setMore] = useState(true);
	const settings = useQuery(mailSettingsQuery(user.id));
	const counts = useQuery({
		queryKey: ["messages", user.id, "counts", effectiveMailbox],
		queryFn: () => mailCountsFn({ data: { mailboxId: effectiveMailbox } }),
		enabled: !!effectiveMailbox,
		staleTime: 30000,
	});
	const [newFolder, setNewFolder] = useState(false),
		[folderName, setFolderName] = useState("");
	const folderMutation = useMutation({
		mutationFn: () =>
			createFolderFn({
				data: { mailboxId: effectiveMailbox, name: folderName },
			}),
		onSuccess: async () => {
			setNewFolder(false);
			setFolderName("");
			await queryClient.invalidateQueries({
				queryKey: ["mail-settings", user.id],
			});
		},
	});
	const activeFolder =
		pathname === "/inbox" || pathname.startsWith("/inbox/")
			? (search.folder ?? "inbox")
			: pathname.slice(1);
	return (
		<MailContext.Provider
			value={{
				user,
				mailboxes,
				mailboxId: effectiveMailbox,
				setMailboxId: setSelected,
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
			<div
				className={`grid h-dvh overflow-hidden bg-[#f6f8fc] ${minimal ? "grid-cols-[72px_minmax(0,1fr)]" : "grid-cols-[256px_minmax(0,1fr)]"} max-md:grid-cols-[72px_minmax(0,1fr)]`}
			>
				<aside className="flex min-h-0 flex-col py-4 pr-3">
					<div className="mb-6 flex h-10 items-center gap-3 px-5">
						<button
							aria-label="Toggle sidebar"
							className="rounded-full p-2 text-neutral-600 hover:bg-neutral-200"
							onClick={() => setMinimal(!minimal)}
						>
							<Menu size={19} />
						</button>
						{!minimal && (
							<Link
								to="/inbox"
								className="flex items-center gap-3 max-md:hidden"
							>
								<img src="/icon.png" width={30} height={30} alt="" />
								<span className="text-xl font-semibold">Mailrun</span>
							</Link>
						)}
					</div>
					<button
						className={`mb-5 ml-3 flex h-14 items-center gap-4 self-start max-md:px-3 rounded-2xl bg-blue-100 px-5 font-medium text-blue-950 shadow-sm hover:bg-blue-200 ${minimal ? "px-3" : ""}`}
						onMouseEnter={() => void loadComposer()}
						onFocus={() => void loadComposer()}
						onClick={() =>
							setCompose((current) => current ?? { key: Date.now() })
						}
					>
						<MailPlus size={22} />
						{!minimal && <span className="max-md:hidden">Compose</span>}
					</button>
					<nav aria-label="Mail folders" className="space-y-0.5">
						{folders
							.filter((_, index) => more || index < 5)
							.map((folder) => (
								<Link
									key={folder.id}
									to={folder.id === "inbox" ? "/inbox" : `/${folder.id}`}
									search={{
										folder: folder.id,
										mailboxId: effectiveMailbox || undefined,
									}}
									className={`flex h-9 items-center gap-4 rounded-r-full px-6 text-sm ${!search.folderId && activeFolder === folder.id ? "bg-blue-100 font-semibold text-blue-950" : "text-neutral-700 hover:bg-stone-200/60"}`}
								>
									<folder.icon size={18} />
									{!minimal && (
										<>
											<span className="max-md:hidden">{folder.label}</span>
											{((folder.id === "inbox"
												? counts.data?.inboxUnread
												: folder.id === "drafts"
													? counts.data?.drafts
													: 0) ?? 0) > 0 && (
												<span className="ml-auto text-xs max-md:hidden">
													{folder.id === "inbox"
														? counts.data?.inboxUnread
														: counts.data?.drafts}
												</span>
											)}
										</>
									)}
								</Link>
							))}
						{!minimal && (
							<button
								className="flex h-9 items-center gap-4 px-6 text-sm text-neutral-600 max-md:hidden"
								onClick={() => setMore(!more)}
							>
								{more ? <ChevronUp size={18} /> : <ChevronDown size={18} />}{" "}
								{more ? "Less" : "More"}
							</button>
						)}
					</nav>
					<div className="mt-5 min-h-0 overflow-y-auto">
						{!minimal && (
							<div className="mb-2 flex items-center justify-between px-6 text-sm font-medium text-neutral-700 max-md:hidden">
								<span>Folders</span>
								{mailboxes.find((item) => item.id === effectiveMailbox)
									?.permission === "full_access" && (
									<button
										aria-label="Create folder"
										onClick={() => setNewFolder(true)}
									>
										<Plus size={17} />
									</button>
								)}
							</div>
						)}
						{settings.data?.folders
							.filter((folder) => folder.mailbox_id === effectiveMailbox)
							.map((folder) => (
								<Link
									key={folder.id}
									to="/inbox"
									search={{
										mailboxId: effectiveMailbox,
										folder: "inbox",
										folderId: folder.id,
									}}
									className={`flex h-9 items-center gap-4 rounded-r-full px-6 text-sm ${search.folderId === folder.id ? "bg-blue-100 font-semibold text-blue-950" : "text-neutral-700 hover:bg-stone-200/60"}`}
								>
									<FolderIcon size={18} />
									{!minimal && (
										<span className="max-md:hidden">{folder.name}</span>
									)}
								</Link>
							))}
					</div>
					<div className="mt-auto space-y-3 px-6 text-xs text-neutral-500">
						<Link to="/settings/mailboxes" className="flex items-center gap-3">
							<Settings size={16} />
							{!minimal && <span className="max-md:hidden">Settings</span>}
						</Link>
						{!minimal && (
							<a
								className="block max-md:hidden"
								href="https://github.com/ilbertt/mailrun"
							>
								Powered by Mailrun
							</a>
						)}
					</div>
				</aside>
				<div className="flex min-h-0 min-w-0 flex-col">
					<header className="flex h-16 shrink-0 items-center gap-4 pr-5 max-md:gap-1 max-md:pr-2">
						<form
							className="flex h-12 max-w-4xl flex-1 items-center gap-3 rounded-full bg-[#eaf1fb] px-5"
							onSubmit={(event) => {
								event.preventDefault();
								void router.navigate({
									to: "/inbox",
									search: {
										mailboxId: effectiveMailbox || undefined,
										q: String(new FormData(event.currentTarget).get("q") ?? ""),
									},
								});
							}}
						>
							<Search size={21} className="text-neutral-600" />
							<input
								type="search"
								aria-label="Search mail"
								name="q"
								placeholder="Search mail (press / to focus)"
								defaultValue={search.q ?? ""}
								className="w-full bg-transparent text-base outline-none"
							/>
						</form>
						<Link
							to="/settings/mailboxes"
							aria-label="Settings"
							className="rounded-full p-2 text-neutral-600 hover:bg-neutral-200"
						>
							<Settings size={20} />
						</Link>
						<select
							aria-label="Mailbox"
							value={effectiveMailbox}
							onChange={(event) => {
								setSelected(event.target.value);
								void router.navigate({
									to: "/inbox",
									search: { mailboxId: event.target.value },
								});
							}}
							className="max-w-48 bg-transparent text-sm max-md:hidden"
						>
							{mailboxes.map((mailbox) => (
								<option key={mailbox.id} value={mailbox.id}>
									{mailbox.local_part}@{mailbox.hostname}
								</option>
							))}
						</select>
						<button
							title={`Sign out ${user.name}`}
							aria-label="Sign out"
							onClick={async () => {
								await logoutFn();
								queryClient.clear();
								await router.navigate({ to: "/login" });
							}}
							className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-200 font-medium text-blue-950"
						>
							{user.name.slice(0, 1).toUpperCase()}
						</button>
					</header>
					<main className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-t-3xl bg-white">
						<Outlet />
					</main>
				</div>
			</div>
			<Dialog open={newFolder} onOpenChange={setNewFolder}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>New folder</DialogTitle>
					</DialogHeader>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							folderMutation.mutate();
						}}
						className="space-y-4"
					>
						<Input
							autoFocus
							aria-label="Folder name"
							value={folderName}
							onChange={(event) => setFolderName(event.target.value)}
							maxLength={100}
							required
						/>
						{folderMutation.error && (
							<p role="alert" className="text-sm text-red-600">
								{folderMutation.error.message}
							</p>
						)}
						<div className="flex justify-end gap-2">
							<Button
								type="button"
								variant="outline"
								onClick={() => setNewFolder(false)}
							>
								Cancel
							</Button>
							<Button disabled={folderMutation.isPending}>Create</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>
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
