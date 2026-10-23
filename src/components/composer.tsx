import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
	ChevronDown,
	Maximize2,
	Minimize2,
	Minus,
	Paperclip,
	Trash2,
	X,
	ChevronUp,
} from "lucide-react";
import {
	saveDraftFn,
	draftFn,
	uploadDraftFn,
	removeDraftAttachmentFn,
	deleteDraftFn,
	sendDraftFn,
	mailSettingsFn,
} from "../functions";
import { RichTextEditor } from "./compose/rich-text-editor";
import { RecipientInput } from "./compose/recipient-input";
import {
	htmlToPlainText,
	textToHtml,
	applyMailboxSignatureHtml,
	splitQuotedHtml,
	joinQuotedHtml,
} from "./compose/rich-text-utils";
import {
	headerToRecipients,
	recipientsToHeader,
} from "./compose/recipient-utils";
import { Button } from "./ui/button";
import { useMail, type ComposeIntent } from "./mail-context";
import { useQuery } from "@tanstack/react-query";

type Draft = Awaited<ReturnType<typeof draftFn>>;
type Fields = {
	mailboxId: string;
	from: string;
	to: string[];
	cc: string[];
	bcc: string[];
	subject: string;
	html: string;
	scheduledAt: string | null;
	inReplyTo: string | null;
	references: string | null;
	threadId: string | null;
};
export function Composer({
	intent,
	onClose,
}: {
	intent: ComposeIntent;
	onClose: (notice?: string) => void;
}) {
	const { user, mailboxes: allMailboxes, mailboxId } = useMail();
	const mailboxes = allMailboxes.filter(
		(mailbox) => mailbox.permission !== "read_only",
	);
	const client = useQueryClient();
	const primary =
		mailboxes.find(
			(item) => item.id === (intent.initial?.mailboxId ?? mailboxId),
		) ?? mailboxes[0];
	const [fields, setFields] = useState<Fields>(() => ({
		mailboxId: primary?.id ?? "",
		from:
			intent.initial?.from ??
			(primary ? `${primary.local_part}@${primary.hostname}` : ""),
		to: headerToRecipients(intent.initial?.to),
		cc: headerToRecipients(intent.initial?.cc),
		bcc: headerToRecipients(intent.initial?.bcc),
		subject: intent.initial?.subject ?? "",
		html:
			intent.initial?.html ??
			applyMailboxSignatureHtml("", "", primary?.signature),
		scheduledAt: intent.initial?.scheduledAt ?? null,
		inReplyTo: intent.initial?.inReplyTo ?? null,
		references: intent.initial?.references ?? null,
		threadId: intent.initial?.threadId ?? null,
	}));
	const [attachments, setAttachments] = useState<Draft["attachments"]>([]);
	const [loading, setLoading] = useState(!!intent.draftId);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState("");
	const [error, setError] = useState("");
	const [ccOpen, setCcOpen] = useState(!!intent.initial?.cc),
		[bccOpen, setBccOpen] = useState(!!intent.initial?.bcc);
	const [minimized, setMinimized] = useState(false),
		[expanded, setExpanded] = useState(false),
		[scheduleOpen, setScheduleOpen] = useState(false);
	const saved = useRef<Draft | null>(null),
		latest = useRef(fields),
		savedKey = useRef(""),
		queue = useRef<Promise<unknown>>(Promise.resolve());
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
		mounted = useRef(true),
		discarded = useRef(false),
		fileInput = useRef<HTMLInputElement>(null);
	latest.current = fields;
	const { data: settings } = useQuery({
		queryKey: ["mail-settings", user.id],
		queryFn: () => mailSettingsFn(),
		staleTime: 60000,
	});
	const emit = (message: string) => {
		if (mounted.current) setError(message);
	};
	const invalidate = () =>
		client.invalidateQueries({ queryKey: ["messages", user.id] });
	function enqueue<T>(work: () => Promise<T>): Promise<T> {
		const next = queue.current.then(work, work);
		queue.current = next.catch(() => {});
		return next;
	}
	async function performSave(snapshot: Fields, force = false) {
		if (discarded.current) return null;
		const key = JSON.stringify(snapshot);
		if (saved.current && savedKey.current === key) return saved.current;
		if (
			!saved.current &&
			!force &&
			!snapshot.to.length &&
			!snapshot.subject.trim() &&
			!htmlToPlainText(snapshot.html).trim()
		)
			return null;
		if (mounted.current) setStatus("Saving…");
		const result = await saveDraftFn({
			data: {
				id: saved.current?.id,
				revision: saved.current?.draft_revision,
				mailboxId: snapshot.mailboxId,
				from: snapshot.from,
				to: recipientsToHeader(snapshot.to),
				cc: recipientsToHeader(snapshot.cc),
				bcc: recipientsToHeader(snapshot.bcc),
				subject: snapshot.subject,
				html: snapshot.html,
				text: htmlToPlainText(snapshot.html),
				scheduledAt: snapshot.scheduledAt,
				inReplyTo: snapshot.inReplyTo,
				references: snapshot.references,
				threadId: snapshot.threadId,
				...(!saved.current && intent.initial?.forwardOfMessageId
					? { forwardOfMessageId: intent.initial.forwardOfMessageId }
					: {}),
			},
		});
		saved.current = result;
		savedKey.current = key;
		if (mounted.current) {
			setStatus("Draft saved");
			setAttachments(result.attachments);
		}
		void invalidate();
		return result;
	}
	const saveRef = useRef(performSave);
	saveRef.current = performSave;
	useEffect(() => {
		mounted.current = true;
		if (intent.draftId)
			void draftFn({ data: { id: intent.draftId } })
				.then((draft) => {
					if (!mounted.current) return;
					saved.current = draft;
					const initial: Fields = {
						mailboxId: draft.mailbox_id,
						from: draft.from_addr,
						to: headerToRecipients(draft.to_addr),
						cc: headerToRecipients(draft.cc_addr),
						bcc: headerToRecipients(draft.bcc_addr),
						subject: draft.subject ?? "",
						html: draft.html_body || textToHtml(draft.text_body),
						scheduledAt: draft.draft_scheduled_at
							? new Date(draft.draft_scheduled_at * 1000).toISOString()
							: null,
						inReplyTo: draft.in_reply_to,
						references: draft.references_header,
						threadId: draft.thread_id,
					};
					savedKey.current = JSON.stringify(initial);
					setFields(initial);
					setAttachments(draft.attachments);
					setCcOpen(initial.cc.length > 0);
					setBccOpen(initial.bcc.length > 0);
					setLoading(false);
				})
				.catch((cause) => {
					emit(cause instanceof Error ? cause.message : "Could not load draft");
					setLoading(false);
				});
		return () => {
			mounted.current = false;
			clearTimeout(timer.current);
			if (!discarded.current) {
				const snapshot = latest.current;
				void enqueue(() => saveRef.current(snapshot)).catch(() => {});
			}
		};
	}, []);
	useEffect(() => {
		if (loading) return;
		clearTimeout(timer.current);
		const snapshot = fields;
		timer.current = setTimeout(() => {
			void enqueue(() => performSave(snapshot)).catch((cause) =>
				emit(cause instanceof Error ? cause.message : "Could not save draft"),
			);
		}, 650);
		return () => clearTimeout(timer.current);
	}, [fields, loading]);
	async function close() {
		clearTimeout(timer.current);
		try {
			await enqueue(() => performSave(latest.current));
			onClose();
		} catch (cause) {
			emit(cause instanceof Error ? cause.message : "Could not save draft");
		}
	}
	async function upload(files: File[]) {
		if (!files.length) return;
		setBusy(true);
		setError("");
		clearTimeout(timer.current);
		try {
			await enqueue(async () => {
				const draft = await performSave(latest.current, true);
				if (!draft) throw new Error("Draft unavailable");
				const form = new FormData();
				form.set("draftId", draft.id);
				for (const file of files) form.append("attachments", file);
				const result = await uploadDraftFn({ data: form });
				saved.current = result;
				setAttachments(result.attachments);
				setStatus("Draft saved");
			});
			void invalidate();
		} catch (cause) {
			emit(cause instanceof Error ? cause.message : "Could not upload files");
		} finally {
			setBusy(false);
			if (fileInput.current) fileInput.current.value = "";
		}
	}
	async function discard() {
		clearTimeout(timer.current);
		setBusy(true);
		try {
			await enqueue(async () => {
				if (saved.current)
					await deleteDraftFn({ data: { id: saved.current.id } });
				discarded.current = true;
			});
			void invalidate();
			onClose();
		} catch (cause) {
			emit(cause instanceof Error ? cause.message : "Could not delete draft");
			setBusy(false);
		}
	}
	async function send() {
		clearTimeout(timer.current);
		setBusy(true);
		setError("");
		try {
			const result = await enqueue(async () => {
				const draft = await performSave(latest.current, true);
				if (!draft) throw new Error("Draft unavailable");
				return sendDraftFn({
					data: { id: draft.id, revision: draft.draft_revision },
				});
			});
			discarded.current = true;
			await invalidate();
			onClose(result.scheduled ? "Message scheduled" : "Message sent");
		} catch (cause) {
			emit(cause instanceof Error ? cause.message : "Could not send message");
		} finally {
			setBusy(false);
		}
	}
	const frame = expanded
		? "fixed inset-6 z-50 flex flex-col overflow-hidden rounded-lg bg-white shadow-2xl max-md:inset-0"
		: "fixed bottom-0 right-6 z-50 flex h-[min(620px,85dvh)] w-[min(640px,calc(100vw-2rem))] flex-col overflow-hidden rounded-t-lg bg-white shadow-[0_4px_24px_#0003] max-md:inset-0 max-md:h-dvh max-md:w-full max-md:rounded-none";
	return (
		<>
			{expanded && <div className="fixed inset-0 z-40 bg-black/30" />}
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void send();
				}}
				className={frame}
				style={minimized ? { height: 36 } : undefined}
				aria-label="New message"
				role="dialog"
				aria-modal={expanded || undefined}
				onDragOver={(event) => {
					if (event.dataTransfer.types.includes("Files"))
						event.preventDefault();
				}}
				onDrop={(event) => {
					if (event.dataTransfer.files.length) {
						event.preventDefault();
						void upload(Array.from(event.dataTransfer.files));
					}
				}}
			>
				<div className="flex h-9 shrink-0 items-center justify-between bg-neutral-800 px-4 text-sm font-medium text-white">
					<span>
						{loading
							? "Loading draft…"
							: fields.inReplyTo
								? "Reply"
								: /^fwd:/i.test(fields.subject)
									? "Forward"
									: "New Message"}
					</span>
					<div className="flex items-center gap-2">
						<button
							type="button"
							aria-label={minimized ? "Restore" : "Minimize"}
							onClick={() => setMinimized(!minimized)}
							className="p-1"
						>
							{minimized ? <ChevronUp size={16} /> : <Minus size={16} />}
						</button>
						<button
							type="button"
							aria-label="Expand composer"
							onClick={() => {
								setExpanded(!expanded);
								setMinimized(false);
							}}
							className="p-1"
						>
							{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
						</button>
						<button
							type="button"
							aria-label="Save and close"
							disabled={busy}
							onClick={() => void close()}
							className="p-1"
						>
							<X size={16} />
						</button>
					</div>
				</div>
				<div
					className={`min-h-0 flex-1 flex-col ${minimized ? "hidden" : "flex"}`}
				>
					<div className="flex items-center gap-4 border-b border-neutral-100 px-4 py-1 text-sm">
						<label htmlFor="compose-from" className="text-neutral-500">
							From
						</label>
						<select
							id="compose-from"
							value={`${fields.mailboxId}|${fields.from}`}
							disabled={loading || busy}
							onChange={(event) => {
								const [mailboxId, from] = event.target.value.split("|");
								if (mailboxId && from)
									setFields((current) => ({ ...current, mailboxId, from }));
							}}
							className="h-8 flex-1 bg-transparent outline-none"
						>
							{mailboxes.flatMap((mailbox) =>
								[
									`${mailbox.local_part}@${mailbox.hostname}`,
									...(settings?.aliases
										.filter((alias) => alias.mailbox_id === mailbox.id)
										.map((alias) => `${alias.local_part}@${alias.hostname}`) ??
										[]),
								].map((address) => (
									<option
										key={`${mailbox.id}|${address}`}
										value={`${mailbox.id}|${address}`}
									>
										{address}
									</option>
								)),
							)}
						</select>
					</div>
					<RecipientInput
						id="compose-to"
						label="To"
						value={fields.to}
						onChange={(to) => setFields((current) => ({ ...current, to }))}
						disabled={loading}
						autoFocus={!intent.draftId}
						required
						trailing={
							<>
								{!ccOpen && (
									<button type="button" onClick={() => setCcOpen(true)}>
										Cc
									</button>
								)}
								{!bccOpen && (
									<button type="button" onClick={() => setBccOpen(true)}>
										Bcc
									</button>
								)}
							</>
						}
					/>
					{ccOpen && (
						<RecipientInput
							id="compose-cc"
							label="Cc"
							value={fields.cc}
							onChange={(cc) => setFields((current) => ({ ...current, cc }))}
						/>
					)}{" "}
					{bccOpen && (
						<RecipientInput
							id="compose-bcc"
							label="Bcc"
							value={fields.bcc}
							onChange={(bcc) => setFields((current) => ({ ...current, bcc }))}
						/>
					)}
					<input
						aria-label="Subject"
						placeholder="Subject"
						value={fields.subject}
						disabled={loading}
						onChange={(event) =>
							setFields((current) => ({
								...current,
								subject: event.target.value,
							}))
						}
						className="h-10 shrink-0 border-b border-neutral-100 px-4 text-sm outline-none"
					/>
					{error && (
						<p role="alert" className="mx-4 my-1 text-xs text-red-600">
							{error}
						</p>
					)}
					{scheduleOpen && (
						<label className="flex items-center gap-3 border-b border-neutral-100 px-4 py-2 text-xs">
							Schedule send
							<input
								aria-label="Schedule send"
								type="datetime-local"
								defaultValue={
									fields.scheduledAt
										? new Date(
												Date.parse(fields.scheduledAt) -
													new Date().getTimezoneOffset() * 60000,
											)
												.toISOString()
												.slice(0, 16)
										: ""
								}
								onChange={(event) =>
									setFields((current) => ({
										...current,
										scheduledAt: event.target.value
											? new Date(event.target.value).toISOString()
											: null,
									}))
								}
							/>
							<button
								type="button"
								onClick={() => {
									setFields((current) => ({ ...current, scheduledAt: null }));
									setScheduleOpen(false);
								}}
							>
								Clear
							</button>
						</label>
					)}
					<RichTextEditor
						id="compose-body"
						value={splitQuotedHtml(fields.html).body}
						quotedHtml={splitQuotedHtml(fields.html).quoted}
						onChange={(html) =>
							setFields((current) => ({
								...current,
								html: joinQuotedHtml(
									html,
									splitQuotedHtml(current.html).quoted,
								),
							}))
						}
						disabled={loading}
						placeholder="Write your message…"
						className="min-h-0 flex-1"
						footerContent={
							attachments.length ? (
								<div className="flex flex-wrap gap-2 px-4 pb-3">
									{attachments.map((attachment) => (
										<span
											key={attachment.id}
											className="flex items-center gap-2 rounded border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs"
										>
											<Paperclip size={12} />
											{attachment.filename}
											<span className="text-neutral-500">
												{Math.ceil(attachment.size / 1024)} KB
											</span>
											<button
												type="button"
												aria-label={`Remove ${attachment.filename}`}
												disabled={busy}
												onClick={() => {
													setBusy(true);
													void enqueue(async () => {
														if (!saved.current) return;
														const result = await removeDraftAttachmentFn({
															data: {
																id: saved.current.id,
																attachmentId: attachment.id,
															},
														});
														saved.current = result;
														setAttachments(result.attachments);
													})
														.catch((cause) =>
															emit(
																cause instanceof Error
																	? cause.message
																	: "Could not remove file",
															),
														)
														.finally(() => setBusy(false));
												}}
											>
												<X size={12} />
											</button>
										</span>
									))}
								</div>
							) : undefined
						}
						toolbarStart={
							<div className="flex">
								<Button
									type="submit"
									size="sm"
									className="rounded-r-none px-4"
									disabled={busy || loading}
								>
									{busy
										? "Preparing…"
										: fields.scheduledAt
											? "Schedule"
											: "Send"}
								</Button>
								<Button
									type="button"
									size="sm"
									className="rounded-l-none border-l border-blue-400 px-2"
									aria-label="Schedule send options"
									onClick={() => setScheduleOpen(!scheduleOpen)}
								>
									<ChevronDown size={14} />
								</Button>
							</div>
						}
						toolbarEnd={
							<>
								<input
									ref={fileInput}
									aria-label="Attachment files"
									type="file"
									multiple
									hidden
									onChange={(event) =>
										void upload(Array.from(event.target.files ?? []))
									}
								/>
								<button
									type="button"
									aria-label="Attach files"
									disabled={busy || loading}
									onClick={() => fileInput.current?.click()}
									className="rounded p-1.5 text-neutral-500 hover:bg-neutral-100"
								>
									<Paperclip size={16} />
								</button>
								<span className="ml-auto text-[10px] text-neutral-400">
									{status}
								</span>
								<button
									type="button"
									aria-label="Delete draft"
									disabled={busy || loading}
									onClick={() => void discard()}
									className="rounded p-1.5 text-neutral-500 hover:bg-red-50 hover:text-red-600"
								>
									<Trash2 size={16} />
								</button>
							</>
						}
					/>
				</div>
			</form>
		</>
	);
}
