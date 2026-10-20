import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { threadQuery } from "../queries";
import { messageActionFn } from "../functions";

export const Route = createFileRoute("/_mail/inbox/$messageId")({
	loader: ({ context, params }) => context.queryClient.ensureQueryData(threadQuery(context.user.id, params.messageId)),
	component: Conversation,
});
function Conversation() {
	const { user, queryClient } = Route.useRouteContext();
	const { messageId } = Route.useParams();
	const options = threadQuery(user.id, messageId);
	const messages = useSuspenseQuery(options).data;
	const mutation = useMutation({
		mutationFn: messageActionFn,
		onMutate: async ({ data }) => {
			await queryClient.cancelQueries({ queryKey: options.queryKey });
			const previous = queryClient.getQueryData(options.queryKey);
			queryClient.setQueryData(options.queryKey, rows => rows?.map(row => row.id === data.id ? { ...row, read: data.action === "read" ? 1 : 0 } : row));
			return { previous };
		},
		onError: (_error, _variables, context) => { if (context?.previous) queryClient.setQueryData(options.queryKey, context.previous); },
		onSettled: async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: options.queryKey }), queryClient.invalidateQueries({ queryKey: ["messages", user.id] })]); },
	});
	return <section className="reading-pane"><div className="reading-toolbar"><Link to="/inbox" search={previous => previous}>← Back</Link><button disabled={mutation.isPending} onClick={() => mutation.mutate({ data: { id: messageId, action: "read" } })}>Mark read</button></div>
		{mutation.error && <p role="alert" className="error">{mutation.error.message}</p>}
		<h1>{messages[0]?.subject || "(No subject)"}</h1>
		{messages.length === 100 && <p className="hint">Showing the latest 100 messages in this conversation.</p>}
		{messages.map(message => <article className="email" key={message.id}><header><strong>{message.from_addr}</strong><time>{new Date(message.created_at * 1000).toLocaleString()}</time><small>To {message.to_addr}</small></header>
			{message.text_body ? <div className="email-text">{message.text_body}</div> : message.html_body ? <iframe title="Email body" sandbox="" referrerPolicy="no-referrer" srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>body{font:14px/1.6 system-ui;overflow-wrap:anywhere}</style>${message.html_body}`} /> : <p>No message body.</p>}
			{message.attachments.map(attachment => <a className="attachment" key={attachment.id} href={`/api/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(attachment.id)}`}>↓ {attachment.filename} ({Math.ceil(attachment.size / 1024)} KB)</a>)}
		</article>)}
	</section>;
}
