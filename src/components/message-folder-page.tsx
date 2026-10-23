import {
	Link,
	Outlet,
	useLocation,
	useNavigate,
	useSearch,
} from "@tanstack/react-router";
import {
	useMutation,
	useQueryClient,
	useSuspenseQuery,
} from "@tanstack/react-query";
import {
	Archive,
	ChevronLeft,
	ChevronRight,
	Filter,
	Inbox,
	RotateCw,
	Star,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { useMail } from "./mail-context";
import { listInputSchema, type Folder } from "../shared/contracts";
import { messagesQuery } from "../queries";
import { messageActionFn } from "../functions";
import { getRecipientLabel } from "./compose/recipient-utils";
export function MessageFolderPage({ folder }: { folder: Folder }) {
	const { user, mailboxId, openComposer } = useMail();
	const search = useSearch({ strict: false });
	const navigate = useNavigate();
	const client = useQueryClient();
	const input = listInputSchema.parse({
		...search,
		folder,
		mailboxId: search.mailboxId ?? mailboxId,
	});
	const pathname = useLocation({ select: (location) => location.pathname });
	const selectedId = pathname.startsWith("/inbox/")
		? decodeURIComponent(pathname.split("/")[2] ?? "")
		: null;
	const { data, isFetching } = useSuspenseQuery(messagesQuery(user.id, input));
	const [selection, setSelection] = useState<string[]>([]);
	const [bulkError, setBulkError] = useState("");
	const mutation = useMutation({
		mutationFn: messageActionFn,
		onSuccess: () =>
			client.invalidateQueries({ queryKey: ["messages", user.id] }),
	});
	const page = (offset: number) => {
		void navigate({
			to: folder === "inbox" ? "/inbox" : `/${folder}`,
			search: { ...input, offset },
		});
	};
	return (
		<div className="flex h-full min-h-0 min-w-0">
			<section
				className={`${selectedId ? "hidden w-[360px] shrink-0 border-r border-neutral-200 lg:flex" : "flex w-full"} min-h-0 flex-col`}
			>
				<div className="flex h-14 shrink-0 items-center gap-4 border-b border-neutral-100 px-5 text-neutral-600">
					<input
						type="checkbox"
						aria-label="Select all messages"
						checked={
							!!data.messages.length &&
							selection.length === data.messages.length
						}
						onChange={(event) =>
							setSelection(
								event.target.checked
									? data.messages.map((message) => message.id)
									: [],
							)
						}
						className="h-4 w-4 accent-blue-600"
					/>
					{selection.length ? (
						<>
							<button
								title="Archive selected"
								aria-label="Archive selected"
								onClick={() => {
									setBulkError("");
									void Promise.all(
										selection.map((id) =>
											messageActionFn({ data: { id, action: "archive" } }),
										),
									)
										.then(() => {
											setSelection([]);
											return client
												.invalidateQueries({
													queryKey: ["messages", user.id],
												})
												.catch(async (error) => {
													setBulkError(
														error instanceof Error
															? error.message
															: "Unable to update messages",
													);
													await client.invalidateQueries({
														queryKey: ["messages", user.id],
													});
												});
										})
										.catch(async (error) => {
											setBulkError(
												error instanceof Error
													? error.message
													: "Unable to update messages",
											);
											await client.invalidateQueries({
												queryKey: ["messages", user.id],
											});
										});
								}}
							>
								<Archive size={18} />
							</button>
							<button
								title="Delete selected"
								aria-label="Delete selected"
								onClick={() => {
									setBulkError("");
									void Promise.all(
										selection.map((id) =>
											messageActionFn({ data: { id, action: "trash" } }),
										),
									)
										.then(() => {
											setSelection([]);
											return client
												.invalidateQueries({
													queryKey: ["messages", user.id],
												})
												.catch(async (error) => {
													setBulkError(
														error instanceof Error
															? error.message
															: "Unable to update messages",
													);
													await client.invalidateQueries({
														queryKey: ["messages", user.id],
													});
												});
										})
										.catch(async (error) => {
											setBulkError(
												error instanceof Error
													? error.message
													: "Unable to update messages",
											);
											await client.invalidateQueries({
												queryKey: ["messages", user.id],
											});
										});
								}}
							>
								<Trash2 size={18} />
							</button>
						</>
					) : (
						<button
							aria-label="Refresh inbox"
							className={isFetching ? "animate-spin" : ""}
							onClick={() => {
								void client.invalidateQueries({
									queryKey: ["messages", user.id],
								});
							}}
						>
							<RotateCw size={17} />
						</button>
					)}
					<span className="ml-auto text-xs">
						{data.messages.length ? input.offset + 1 : 0}–
						{input.offset + data.messages.length}
						{data.hasMore ? " of many" : ""}
					</span>
					<button
						aria-label="Previous page"
						disabled={!input.offset}
						onClick={() => page(Math.max(0, input.offset - 50))}
						className="disabled:opacity-30"
					>
						<ChevronLeft size={18} />
					</button>
					<button
						aria-label="Next page"
						disabled={!data.hasMore}
						onClick={() => page(input.offset + 50)}
						className="disabled:opacity-30"
					>
						<ChevronRight size={18} />
					</button>
				</div>
				{(mutation.error || bulkError) && (
					<p role="alert" className="p-3 text-sm text-red-600">
						{mutation.error?.message || bulkError}
					</p>
				)}
				<div className="min-h-0 flex-1 overflow-y-auto">
					{data.messages.map((message) => (
						<div
							key={message.id}
							className={`group relative flex items-start gap-3 border-b border-neutral-100 px-5 ${selectedId ? "py-4" : "py-3"} ${selectedId === message.id ? "border-l-2 border-l-blue-600 bg-blue-50" : message.read ? "bg-[#f2f6fc]" : "bg-white"} hover:shadow-[inset_0_1px_0_#dadce0,inset_0_-1px_0_#dadce0]`}
						>
							<input
								type="checkbox"
								aria-label={`Select ${message.subject || "message"}`}
								checked={selection.includes(message.id)}
								onChange={(event) =>
									setSelection((current) =>
										event.target.checked
											? [...current, message.id]
											: current.filter((id) => id !== message.id),
									)
								}
								className="mt-1 h-4 w-4 shrink-0 accent-blue-600"
							/>
							<button
								aria-label={message.starred ? "Unstar message" : "Star message"}
								disabled={mutation.isPending}
								className={`mt-0.5 shrink-0 ${message.starred ? "text-amber-500" : "text-neutral-400"}`}
								onClick={() =>
									mutation.mutate({
										data: {
											id: message.id,
											action: message.starred ? "unstar" : "star",
										},
									})
								}
							>
								<Star
									size={17}
									fill={message.starred ? "currentColor" : "none"}
								/>
							</button>
							<Link
								to="/inbox/$messageId"
								params={{ messageId: message.id }}
								search={input}
								preload={folder === "drafts" ? false : "intent"}
								onClick={(event) => {
									if (folder === "drafts") {
										event.preventDefault();
										openComposer({ draftId: message.id });
									}
								}}
								className={`min-w-0 flex-1 ${selectedId ? "" : "flex items-center gap-5 max-md:block"}`}
							>
								<div
									className={`${selectedId ? "flex items-center justify-between gap-3" : "w-44 shrink-0 max-md:w-full"}`}
								>
									<span
										className={`truncate text-sm ${message.read ? "font-normal" : "font-semibold"}`}
									>
										{folder === "drafts" ? (
											<span className="text-red-600">Draft</span>
										) : (
											getRecipientLabel(message.from_addr ?? "")
										)}
									</span>
									{selectedId && (
										<time className="shrink-0 text-xs text-neutral-500">
											{new Date(message.created_at * 1000)
												.toISOString()
												.slice(5, 10)}
										</time>
									)}
								</div>
								<div
									className={`min-w-0 flex-1 ${selectedId ? "mt-1" : "flex items-center gap-2"}`}
								>
									<span
										className={`truncate text-sm ${message.read ? "" : "font-semibold"}`}
									>
										{message.subject || "(No subject)"}
									</span>
									<span
										className={`truncate text-sm text-neutral-500 ${selectedId ? "mt-1 block" : ""}`}
									>
										{selectedId ? "" : "– "}
										{message.snippet}
									</span>
								</div>
								{!selectedId && (
									<time className="shrink-0 text-xs text-neutral-500">
										{new Date(message.created_at * 1000)
											.toISOString()
											.slice(5, 10)}
									</time>
								)}
							</Link>
						</div>
					))}
					{!data.messages.length && (
						<div className="flex h-full min-h-64 flex-col items-center justify-center gap-4 text-neutral-500">
							<Inbox size={42} strokeWidth={1} />
							<h1 className="text-xl font-normal">
								{folder === "drafts"
									? "You don't have any saved drafts"
									: input.q
										? "No messages found"
										: "Your inbox is empty"}
							</h1>
						</div>
					)}
				</div>
			</section>
			{selectedId && <Outlet />}
		</div>
	);
}
