import { z } from "zod";
import type { User } from "../../shared/contracts";
import { draftSchema } from "../../shared/mail-contracts";
import {
	getDraft,
	saveDraft,
	uploadAttachments,
	removeAttachment,
	deleteDraft,
	attachmentLimit,
	draftLock,
} from "../mail/drafts";
import { sendDraft } from "../mail/send";
import { withDatabase, seconds } from "../db";
import { iso } from "../mail/message-query";
import { readLimitedBody } from "../mail/inbound";
import { messageRecord } from "../mail/message-actions";
export function expectedDraftRevision(request: Request, current: number) {
	const match = request.headers.get("if-match");
	if (!match) return current;
	const value = /^"(\d+)"$/.exec(match)?.[1];
	if (!value || !Number.isSafeInteger(Number(value)))
		throw new Response("Invalid draft revision", { status: 412 });
	if (Number(value) !== current)
		throw new Response(
			"This draft changed in another tab. Reopen it before saving.",
			{ status: 409 },
		);
	return Number(value);
}
async function sourceDraft(user: User, id: string) {
	const draft = await getDraft(user, id);
	const [agent] = await withDatabase(
		(sql) =>
			sql.SourceDraftAgent`SELECT revision,origin,scheduled_at FROM agent_draft_metadata WHERE draft_id=${id}`,
	);
	return {
		id: draft.id,
		userId: draft.user_id,
		status: draft.status,
		mailboxId: draft.mailbox_id,
		fromAddr: draft.from_addr,
		toAddr: draft.to_addr,
		ccAddr: draft.cc_addr,
		bccAddr: draft.bcc_addr,
		subject: draft.subject,
		textBody: draft.text_body,
		htmlBody: draft.html_body,
		inReplyTo: draft.in_reply_to,
		references: draft.references_header,
		threadId: draft.thread_id,
		revision: draft.draft_revision,
		attachments: draft.attachments.map((file) => ({
			id: file.id,
			messageId: file.message_id,
			contentId: file.content_id,
			filename: file.filename,
			size: file.size,
			type: file.content_type,
			disposition: file.disposition === "inline" ? "inline" : "attachment",
		})),
		agent: agent
			? {
					revision: agent.revision,
					origin: agent.origin,
					scheduledAt: iso(agent.scheduled_at),
				}
			: null,
	};
}
export async function draftResponse(
	user: User,
	id: string,
	attachmentsOnly = false,
) {
	const draft = await sourceDraft(user, id);
	const { revision, ...body } = draft;
	return Response.json(
		attachmentsOnly ? { attachments: draft.attachments } : { draft: body },
		{
			headers: {
				ETag: `"${draft.revision}"`,
				"X-Mailflare-Draft-Revision": String(draft.revision),
				"X-Mailflare-Draft-Id": draft.id,
				"Cache-Control": "private, no-store, no-transform",
			},
		},
	);
}
async function jsonBody(request: Request) {
	return JSON.parse(
		new TextDecoder().decode(await readLimitedBody(request, 2_100_000)),
	) as unknown;
}
const uploadFiles = (form: FormData) =>
	form.getAll("attachments").map((value) => {
		if (!(value instanceof File))
			throw new Response("Invalid attachment", { status: 400 });
		return value;
	});
export async function draftsApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	const path = new URL(request.url).pathname,
		method = request.method;
	if (path === "/api/attachment-policy" && method === "GET")
		return Response.json({
			maxMb: (await attachmentLimit()) / 1_000_000,
			cloudThresholdBytes: 3_000_000,
		});
	if (path === "/api/drafts" && method === "POST") {
		const data = draftSchema
			.omit({ id: true, revision: true })
			.parse(await jsonBody(request));
		const draft = await saveDraft(user, data);
		return draftResponse(user, draft.id);
	}
	const match = /^\/api\/drafts\/([^/]+)(?:\/attachments(?:\/([^/]+))?)?$/.exec(
		path,
	);
	if (match) {
		const draftId = decodeURIComponent(match[1] ?? ""),
			fileId = match[2] ? decodeURIComponent(match[2]) : undefined;
		const attachments = path.includes("/attachments");
		if (method === "GET" && !attachments) return draftResponse(user, draftId);
		if (method === "PATCH" && !attachments) {
			const draft = await getDraft(user, draftId),
				revision = expectedDraftRevision(request, draft.draft_revision);
			const data = draftSchema
				.omit({ id: true, revision: true })
				.parse(await jsonBody(request));
			const [agent] = await withDatabase(
				(sql) =>
					sql.MutableDraftAgent`SELECT mailbox_id FROM agent_draft_metadata WHERE draft_id=${draftId}`,
			);
			if (agent && agent.mailbox_id !== data.mailboxId)
				throw new Response("Agent draft mailbox cannot be changed", {
					status: 409,
				});
			const saved = await saveDraft(user, { ...data, id: draftId, revision });
			return draftResponse(user, saved.id);
		}
		if (method === "DELETE" && !attachments) {
			const draft = await getDraft(user, draftId);
			expectedDraftRevision(request, draft.draft_revision);
			await deleteDraft(user, draftId, draft.draft_revision);
			return Response.json({ ok: true });
		}
		if (method === "POST" && attachments && !fileId) {
			const draft = await getDraft(user, draftId);
			expectedDraftRevision(request, draft.draft_revision);
			await uploadAttachments(
				user,
				draftId,
				uploadFiles(await request.formData()),
				draft.draft_revision,
			);
			return draftResponse(user, draftId, true);
		}
		if (method === "DELETE" && fileId) {
			const draft = await getDraft(user, draftId);
			expectedDraftRevision(request, draft.draft_revision);
			await removeAttachment(user, draftId, fileId, draft.draft_revision);
			return draftResponse(user, draftId, true);
		}
	}
	if (path === "/api/send" && method === "POST") {
		const form = await request.formData();
		const draftId = form.get("draftId");
		const old =
			typeof draftId === "string" && draftId
				? await getDraft(user, draftId)
				: null;
		if (old) {
			const [agent] = await withDatabase(
				(sql) =>
					sql.AgentSendingGuard`SELECT draft_id FROM agent_draft_metadata WHERE draft_id=${old.id}`,
			);
			if (agent)
				throw new Response(
					"Review and approve this assistant draft before sending",
					{ status: 409 },
				);
		}
		const data = draftSchema.parse({
			mailboxId: form.get("mailboxId"),
			from: form.get("from") ?? undefined,
			to: form.get("to") ?? "",
			cc: form.get("cc") ?? "",
			bcc: form.get("bcc") ?? "",
			subject: form.get("subject") ?? "",
			text: form.get("text") ?? "",
			html: form.get("html") ?? "",
			inReplyTo: form.get("inReplyTo"),
			references: form.get("references"),
			threadId: form.get("threadId"),
			scheduledAt: form.get("scheduledAt"),
		});
		const saved = await saveDraft(user, {
			...data,
			...(old
				? {
						id: old.id,
						revision: expectedDraftRevision(request, old.draft_revision),
					}
				: {}),
		});
		const files = uploadFiles(form);
		const ready = files.length
			? await uploadAttachments(user, saved.id, files, saved.draft_revision)
			: saved;
		return Response.json(await sendDraft(user, ready.id, ready.draft_revision));
	}
	const cancel = /^\/api\/messages\/([^/]+)\/cancel-schedule$/.exec(path);
	if (cancel && method === "POST") {
		const id = decodeURIComponent(cancel[1] ?? "");
		await messageRecord(user, id, "send");
		await draftLock(id, async () =>
			withDatabase((sql) =>
				sql.begin(async (sql) => {
					const [message] =
						await sql.OwnScheduledDraft`SELECT id FROM messages WHERE id=${id} AND direction='outbound' AND status='queued'`;
					if (!message)
						throw new Response("Scheduled message not found", { status: 404 });
					const jobs =
						await sql.CancelScheduledJob`DELETE FROM outbound_jobs WHERE message_id=${id} AND status='queued' AND scheduled_at IS NOT NULL RETURNING id`;
					if (!jobs.length)
						throw new Response("This send has already started", {
							status: 409,
						});
					await sql.ReturnScheduledToDraft`UPDATE messages SET status='draft',draft_scheduled_at=NULL,draft_revision=draft_revision+1 WHERE id=${id} AND status='queued'`;
				}),
			),
		);
		return Response.json({ ok: true });
	}
	return null;
}
