import { useParams, Link } from "@tanstack/react-router";
import {
	useQueryClient,
	useQuery,
	useMutation,
	useSuspenseQuery,
} from "@tanstack/react-query";
import {
	ArrowLeft,
	Archive,
	Forward,
	MailOpen,
	Paperclip,
	Reply,
	ReplyAll,
	Star,
	Trash2,
} from "lucide-react";
import { threadQuery, mailSettingsQuery } from "../queries";
import { messageActionFn } from "../functions";
import { EmailHtmlRenderer } from "./messages/email-html-renderer";
import { useMail } from "./mail-context";
import {
	escapeHtml,
	textToHtml,
	wrapQuotedHtml,
} from "./compose/rich-text-utils";
import { getEmailAddress, splitEmailAddressList } from "../lib/email/address";
import {
	getRecipientLabel,
	parseRecipientEntries,
} from "./compose/recipient-utils";
import { resolveEmailCidUrls } from "../lib/email/html";
export function Conversation({ messageId }: { messageId: string }) {
	const { user } = useMail();
	const queryClient = useQueryClient();
	const { folderId } = useParams({ strict: false });
	const { openComposer, mailboxes } = useMail();
	const settings = useQuery(mailSettingsQuery(user.id));
	const messages = useSuspenseQuery(threadQuery(user.id, messageId)).data;
	const mutation = useMutation({
		mutationFn: messageActionFn,
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["messages", user.id] }),
				queryClient.invalidateQueries({ queryKey: ["thread", user.id] }),
			]);
		},
	});
	const reply = (
		message: (typeof messages)[number],
		mode: "reply" | "all" | "forward",
	) => {
		const own = new Set(
			[
				user.email,
				...(settings.data?.aliases.map(
					(alias) => `${alias.local_part}@${alias.hostname}`,
				) ?? []),
				...mailboxes.map(
					(mailbox) => `${mailbox.local_part}@${mailbox.hostname}`,
				),
			].map((value) => getEmailAddress(value).toLowerCase()),
		);
		const sender = message.reply_to || message.from_addr;
		const recipients =
			mode === "forward"
				? []
				: mode === "reply"
					? [sender]
					: parseRecipientEntries(
							[sender, message.to_addr, message.cc_addr]
								.filter(Boolean)
								.join(", "),
						).filter(
							(value) =>
								!own.has(getEmailAddress(value).toLowerCase()) ||
								getEmailAddress(value) === getEmailAddress(sender),
						);
		const quote = `<div>On ${new Date(message.created_at * 1000).toISOString().slice(0, 16).replace("T", " ")}, ${escapeHtml(message.from_addr)} wrote:</div>${message.html_body || textToHtml(message.text_body)}`;
		openComposer({
			initial: {
				mailboxId: message.mailbox_id ?? undefined,
				to: recipients.join(", "),
				subject:
					mode === "forward"
						? `Fwd: ${message.subject ?? ""}`
						: /^re:/i.test(message.subject ?? "")
							? (message.subject ?? "")
							: `Re: ${message.subject ?? ""}`,
				html: `<div><br></div>${wrapQuotedHtml(quote)}`,
				inReplyTo: mode === "forward" ? null : message.provider_message_id,
				references:
					mode === "forward"
						? null
						: [message.references_header, message.provider_message_id]
								.filter(Boolean)
								.join(" "),
				threadId: mode === "forward" ? null : message.thread_id,
				...(mode === "forward" ? { forwardOfMessageId: message.id } : {}),
			},
		});
	};
	return (
		<section className="flex min-h-0 min-w-0 flex-1 flex-col">
			<div className="flex h-14 shrink-0 items-center gap-5 border-b border-neutral-100 px-5 text-neutral-600">
				<Link
					to={folderId ? "/folders/$folderId" : "/inbox"}
					params={{ folderId: folderId ?? "" }}
					search={(previous) => previous}
					aria-label={folderId ? "Back to folder" : "Back to inbox"}
				>
					<ArrowLeft size={19} />
				</Link>
				<button
					aria-label="Archive message"
					onClick={() =>
						mutation.mutate({ data: { id: messageId, action: "archive" } })
					}
				>
					<Archive size={19} />
				</button>
				<button
					aria-label="Delete message"
					onClick={() =>
						mutation.mutate({ data: { id: messageId, action: "trash" } })
					}
				>
					<Trash2 size={19} />
				</button>
				<button
					aria-label="Mark read"
					onClick={() =>
						mutation.mutate({ data: { id: messageId, action: "read" } })
					}
				>
					<MailOpen size={19} />
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-7 py-5 max-md:px-4">
				<h1 className="mb-6 text-2xl font-normal">
					{messages[0]?.subject || "(No subject)"}
				</h1>
				{mutation.error && (
					<p role="alert" className="text-sm text-red-600">
						{mutation.error.message}
					</p>
				)}
				{messages.map((message) => {
					const cid = new Map(
						message.attachments
							.filter((attachment) => attachment.content_id)
							.map((attachment) => [
								(attachment.content_id ?? "").replace(/^<|>$/g, ""),
								`/api/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(attachment.id)}?inline=1`,
							]),
					);
					return (
						<article
							className="border-b border-neutral-100 pb-7 pt-3"
							key={message.id}
						>
							<header className="mb-6 flex gap-4">
								<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-lg text-neutral-600">
									{getRecipientLabel(message.from_addr)
										.slice(0, 1)
										.toUpperCase()}
								</div>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-3">
										<span className="min-w-0 truncate font-semibold">
											{getRecipientLabel(message.from_addr)}
										</span>
										<span className="truncate text-xs text-neutral-500 max-md:hidden">
											{getEmailAddress(message.from_addr)}
										</span>
										<time className="ml-auto shrink-0 whitespace-nowrap text-xs text-neutral-500 max-md:hidden">
											{new Date(message.created_at * 1000)
												.toISOString()
												.slice(0, 16)
												.replace("T", " ")}
										</time>
										<button
											aria-label="Reply"
											onClick={() => reply(message, "reply")}
										>
											<Reply size={17} className="text-neutral-600" />
										</button>
									</div>
									<p className="mt-1 break-words text-xs text-neutral-500">
										to {message.to_addr}
									</p>
								</div>
							</header>
							<div className="pl-14 max-md:pl-0">
								{message.html_body ? (
									<EmailHtmlRenderer
										html={resolveEmailCidUrls(message.html_body, cid)}
									/>
								) : (
									<div className="whitespace-pre-wrap break-words text-sm leading-7">
										{message.text_body || "No message body."}
									</div>
								)}
								{!!message.attachments.length && (
									<div className="mt-7 flex flex-wrap gap-3">
										{message.attachments.map((attachment) => (
											<a
												key={attachment.id}
												href={`/api/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(attachment.id)}`}
												className="flex min-w-0 items-center gap-2 break-all rounded-lg border border-neutral-200 px-4 py-3 text-sm hover:bg-neutral-50"
											>
												<Paperclip size={16} />
												{attachment.filename}
												<span className="text-xs text-neutral-400">
													{Math.ceil(attachment.size / 1024)} KB
												</span>
											</a>
										))}
									</div>
								)}
								<div className="mt-8 flex flex-wrap gap-3">
									{[
										{ mode: "reply", label: "Reply", icon: Reply },
										{ mode: "all", label: "Reply all", icon: ReplyAll },
										{ mode: "forward", label: "Forward", icon: Forward },
									].map((action) => (
										<button
											key={action.mode}
											className="flex items-center gap-2 rounded-full border border-neutral-300 px-5 py-2 text-sm text-neutral-600 hover:bg-neutral-50"
											onClick={() =>
												reply(
													message,
													action.mode === "reply"
														? "reply"
														: action.mode === "all"
															? "all"
															: "forward",
												)
											}
										>
											<action.icon size={16} />
											{action.label}
										</button>
									))}
								</div>
							</div>
						</article>
					);
				})}
			</div>
		</section>
	);
}
