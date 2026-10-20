import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { listInputSchema, type ListInput } from "../shared/contracts";
import { mailboxesQuery, messagesQuery, threadQuery } from "../queries";
import { messageActionFn } from "../functions";
import { Composer } from "../components/composer";

export const Route = createFileRoute("/_mail/inbox")({
	validateSearch: listInputSchema,
	loaderDeps: ({ search }) => search,
	loader: async ({ context, deps }) => {
		const mailboxes = await context.queryClient.ensureQueryData(mailboxesQuery(context.user.id));
		const input = { ...deps, mailboxId: deps.mailboxId ?? mailboxes[0]?.id };
		await context.queryClient.ensureQueryData(messagesQuery(context.user.id, input));
	},
	component: Inbox,
});
function Inbox() {
	const { user, queryClient } = Route.useRouteContext();
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const mailboxes = useSuspenseQuery(mailboxesQuery(user.id)).data;
	const input: ListInput = { ...search, mailboxId: search.mailboxId ?? mailboxes[0]?.id };
	const options = messagesQuery(user.id, input);
	const { data } = useSuspenseQuery(options);
	const action = useMutation({
		mutationFn: messageActionFn,
		onMutate: async ({ data: mutation }) => {
			await queryClient.cancelQueries({ queryKey: options.queryKey });
			const previous = queryClient.getQueryData(options.queryKey);
			queryClient.setQueryData(options.queryKey, current => current ? { ...current, messages: current.messages.map(message => message.id === mutation.id ? { ...message, starred: mutation.action === "star" ? 1 : 0 } : message) } : current);
			return { previous };
		},
		onError: (_error, _variables, context) => { if (context?.previous) queryClient.setQueryData(options.queryKey, context.previous); },
		onSettled: () => queryClient.invalidateQueries({ queryKey: options.queryKey }),
	});
	return <div className="mail-content"><section className="message-pane">
		<div className="list-toolbar"><h1>{search.folder[0]?.toUpperCase()}{search.folder.slice(1)}</h1>
			{input.mailboxId && <Composer mailboxId={input.mailboxId} userId={user.id} />}
			<button aria-label="Refresh inbox" onClick={() => { void queryClient.invalidateQueries({ queryKey: options.queryKey }); }}>↻</button>
			<select aria-label="Mailbox" value={input.mailboxId ?? ""} onChange={event => { void navigate({ search: { ...search, mailboxId: event.target.value, offset: 0 } }); }}>
				{mailboxes.map(mailbox => <option key={mailbox.id} value={mailbox.id}>{mailbox.local_part}@{mailbox.hostname}</option>)}
			</select>
		</div>
		<form className="search" onSubmit={event => { event.preventDefault(); const q = String(new FormData(event.currentTarget).get("q") ?? ""); void navigate({ search: { ...search, q, offset: 0 } }); }}>
			<input name="q" type="search" aria-label="Search mail" placeholder="Search your mail" defaultValue={search.q} /><button>Search</button>
		</form>
		{action.error && <p role="alert" className="error">{action.error.message}</p>}
		<div className="message-list">{data.messages.map(message => <div className={`message-row ${message.read ? "" : "unread"}`} key={message.id}>
			<button aria-label={message.starred ? "Unstar message" : "Star message"} className={`star ${message.starred ? "selected" : ""}`} disabled={action.isPending} onClick={() => action.mutate({ data: { id: message.id, action: message.starred ? "unstar" : "star" } })}>{message.starred ? "★" : "☆"}</button>
			<Link to="/inbox/$messageId" params={{ messageId: message.id }} search={search} onMouseEnter={() => { void queryClient.prefetchQuery(threadQuery(user.id, message.id)); }} onFocus={() => { void queryClient.prefetchQuery(threadQuery(user.id, message.id)); }}>
				<div className="row-heading"><strong>{message.from_addr}</strong><time>{new Date(message.created_at * 1000).toLocaleDateString("en", { month: "short", day: "numeric" })}</time></div>
				<div className="subject">{message.subject || "(No subject)"}</div><p>{message.snippet}</p>
			</Link>
		</div>)}</div>
		{!data.messages.length && <div className="empty"><span className="empty-icon">✉</span><h2>{mailboxes.length ? "You're all caught up" : "Connect your first mailbox"}</h2><p>{search.q ? "No messages match your search." : mailboxes.length ? "New messages will appear here." : "Open setup to connect your Cloudflare domain."}</p></div>}
		<footer className="pagination"><button disabled={!search.offset} onClick={() => { void navigate({ search: { ...search, offset: Math.max(0, search.offset - 50) } }); }}>Previous</button><span>{data.messages.length ? search.offset + 1 : 0}–{search.offset + data.messages.length}</span><button disabled={!data.hasMore} onClick={() => { void navigate({ search: { ...search, offset: search.offset + 50 } }); }}>Next</button></footer>
	</section><Outlet /></div>;
}
