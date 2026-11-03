import { z } from "zod";
import type { User } from "../../shared/contracts";
import { sendEmailSchema } from "../../lib/validators";
import { readLimitedBody } from "../http/body";
import { readMailForm } from "../http/draft-form";
import { getDraft } from "../mail/drafts";
import { deliverJob } from "../mail/send";
import { withDatabase } from "../db";
import { expectedDraftRevision } from "../mail/draft-revision";
import { queueSessionSend, cancelSessionSend } from "../mail/session-send";
import { apiErrorResponse } from "./errors";
import { MailboxAccessError } from "../mail/access";
async function parse(request: Request) {
	try {
		if (!request.headers.get("Content-Type")?.includes("multipart/form-data")) {
			const raw: unknown = JSON.parse(
				new TextDecoder().decode(
					await readLimitedBody(request, 30 * 1024 * 1024),
				),
			);
			const object = z.record(z.string(), z.unknown()).safeParse(raw);
			const fields = object.success ? object.data : {};
			if (
				fields.attachments !== undefined &&
				(!Array.isArray(fields.attachments) || fields.attachments.length)
			)
				throw new Error("JSON attachments use the public API");
			return {
				fields,
				draftId:
					typeof fields.draftId === "string" && fields.draftId
						? fields.draftId
						: undefined,
				files: [] as File[],
			};
		}
		const form = await readMailForm(request, "Invalid send request");
		const optional = (key: string) => {
			const value = form.get(key);
			return typeof value === "string" && value ? value : undefined;
		};
		return {
			fields: {
				from: String(form.get("from") ?? ""),
				to: String(form.get("to") ?? ""),
				cc: optional("cc"),
				bcc: optional("bcc"),
				inReplyTo: optional("inReplyTo"),
				references: optional("references"),
				threadId: optional("threadId"),
				scheduledAt: optional("scheduledAt"),
				subject: String(form.get("subject") ?? ""),
				text: optional("text"),
				html: optional("html"),
				mailboxId: optional("mailboxId"),
			},
			draftId: optional("draftId"),
			files: form
				.getAll("attachments")
				.filter(
					(value): value is File => value instanceof File && value.size > 0,
				),
		};
	} catch (error) {
		if (error instanceof Response) throw error;
		throw new Response("Invalid send request", {
			status:
				error instanceof Error && error.message === "Message too large"
					? 413
					: 400,
		});
	}
}
const status = (message: string) =>
	message === "Mailbox is required"
		? 400
		: /^(Attachments exceed|Subject exceeds|Headers exceed|Message exceeds Cloudflare|A message can include at most)/.test(
					message,
				) || message.includes("exceeds the 25 MB attachment limit")
			? 400
			: [
						"Mailbox not found",
						"Sender account not found",
						"You do not have permission to send from this mailbox",
						"Sender address does not match the selected mailbox",
					].includes(message)
				? 403
				: 500;
export async function sessionSendApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	const path = new URL(request.url).pathname;
	if (request.method !== "POST") return null;
	const cancel = /^\/api\/messages\/([^/]+)\/cancel-schedule$/.exec(path);
	if (cancel)
		return Response.json(
			await cancelSessionSend(user, decodeURIComponent(cancel[1] ?? "")),
		);
	if (path !== "/api/send") return null;
	let headers: HeadersInit | undefined;
	try {
		const input = await parse(request),
			parsed = sendEmailSchema
				.omit({ attachments: true })
				.safeParse(input.fields);
		if (!parsed.success)
			return Response.json({ error: parsed.error.flatten() }, { status: 400 });
		if (
			parsed.data.scheduledAt &&
			Date.parse(parsed.data.scheduledAt) < Date.now() - 60_000
		)
			return Response.json(
				{ error: "Scheduled time has already passed" },
				{ status: 400 },
			);
		let draft: { id: string; revision: number } | undefined;
		if (input.draftId) {
			const current = await getDraft(user, input.draftId);
			const [agent] = await withDatabase(
				(sql) =>
					sql.SourceSessionSendAgent`SELECT draft_id FROM agent_draft_metadata WHERE draft_id=${input.draftId}`,
			);
			if (agent)
				return Response.json(
					{ error: "Review and confirm this AI draft before sending" },
					{ status: 409 },
				);
			draft = {
				id: current.id,
				revision: expectedDraftRevision(request, current.draft_revision),
			};
		}
		const queued = await queueSessionSend(
			user,
			parsed.data,
			input.files,
			new URL(request.url).origin,
			draft,
		);
		if (queued.draft)
			headers = {
				ETag: `"${queued.draft.revision}"`,
				"X-Mailflare-Draft-Id": queued.draft.id,
				"X-Mailflare-Draft-Revision": String(queued.draft.revision),
				"Cache-Control": "private, no-store, no-transform",
			};
		if (!queued.scheduled) await deliverJob(queued.jobId);
		return Response.json(
			{
				messageId: queued.messageId,
				...(queued.scheduled ? { scheduled: true } : {}),
			},
			{ headers },
		);
	} catch (error) {
		if (error instanceof Response) {
			const result = await apiErrorResponse(error);
			for (const [key, value] of new Headers(headers))
				result.headers.set(key, value);
			return result;
		}
		if (error instanceof Error && error.message === "Draft not found")
			return Response.json(
				{ error: "Draft not found" },
				{ status: 404, headers },
			);
		if (error instanceof MailboxAccessError)
			return Response.json(
				{ error: "You do not have permission to send from this mailbox" },
				{ status: 403, headers },
			);
		if (
			error instanceof Error &&
			/draft changed|another tab|no longer editable|is being saved/.test(
				error.message,
			)
		) {
			const response = await apiErrorResponse(error);
			for (const [key, value] of new Headers(headers))
				response.headers.set(key, value);
			return response;
		}
		const message = error instanceof Error ? error.message : "Send failed";
		return Response.json(
			{ error: message },
			{ status: status(message), headers },
		);
	}
}
