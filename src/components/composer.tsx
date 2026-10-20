import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sendFn } from "../functions";

export function Composer({ mailboxId, userId }: { mailboxId: string; userId: string }) {
	const [open, setOpen] = useState(false);
	const client = useQueryClient();
	const mutation = useMutation({ mutationFn: sendFn, onSuccess: async () => {
		setOpen(false);
		await client.invalidateQueries({ queryKey: ["messages", userId] });
	} });
	return <>
		<button className="primary compose-button" onClick={() => setOpen(true)}>＋ Compose</button>
		{open && <div className="compose-overlay"><section className="composer" role="dialog" aria-modal="true" aria-labelledby="compose-title">
			<header><h2 id="compose-title">New message</h2><button aria-label="Close composer" onClick={() => setOpen(false)}>×</button></header>
			<form onSubmit={event => {
				event.preventDefault(); const form = new FormData(event.currentTarget);
				const time = String(form.get("scheduledAt") ?? "");
				mutation.mutate({ data: { mailboxId, to: String(form.get("to")), subject: String(form.get("subject")), text: String(form.get("text")), ...(time ? { scheduledAt: new Date(time).toISOString() } : {}) } });
			}}>
				<label>To<input name="to" type="email" required autoFocus /></label>
				<label>Subject<input name="subject" maxLength={998} /></label>
				<textarea name="text" aria-label="Message" required rows={12} />
				<label>Schedule for (optional)<input name="scheduledAt" type="datetime-local" /></label>
				{mutation.error && <p className="error" role="alert">{mutation.error.message}</p>}
				<button className="primary" disabled={mutation.isPending}>{mutation.isPending ? "Sending…" : "Send"}</button>
			</form>
		</section></div>}
	</>;
}
