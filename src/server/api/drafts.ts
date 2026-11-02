import { z } from "zod";
import { sessionSendApi } from "./session-send";
import type { User } from "../../shared/contracts";
import { draftSchema } from "../../shared/mail-contracts";
import {
	getDraft,
	saveDraft,
	uploadAttachments,
	removeAttachment,
	deleteDraft,
	attachmentLimit,
	formattedSender,
} from "../mail/drafts";
import { withDatabase } from "../db";
import { iso, toStoredSourceMessage } from "../mail/message-query";
import { readLimitedBody } from "../mail/inbound";
import { parseAgentScheduledAt } from "../agent/schedule";
import { MailboxAccessError } from "../mail/access";
import { readDraftAttachmentFiles } from "../http/draft-form";
import { expectedDraftRevision } from "../mail/draft-revision";
export { expectedDraftRevision };
import { messageRecord } from "../mail/message-actions";
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
	try {
		return JSON.parse(
			new TextDecoder().decode(await readLimitedBody(request, 1024 * 1024)),
		) as unknown;
	} catch (error) {
		throw new Response("Invalid draft request", {
			status:
				error instanceof Error && error.message === "Message too large"
					? 413
					: 400,
		});
	}
}
const sourceInput = draftSchema
	.omit({ id: true, revision: true })
	.partial({ mailboxId: true })
	.extend({
		subject: draftSchema.shape.subject.removeDefault().optional(),
		scheduledAt: z.string().nullable().optional(),
	});
async function draftData(
	user: User,
	input: unknown,
	agent?: { mailbox_id: string },
) {
	const data = sourceInput.parse(input);
	if (agent && data.mailboxId !== agent.mailbox_id)
		throw new Response("Agent draft mailbox cannot be changed", {
			status: 409,
		});
	let scheduledAt: string | null | undefined;
	if (agent && data.scheduledAt !== undefined) {
		try {
			scheduledAt =
				parseAgentScheduledAt(data.scheduledAt)?.toISOString() ?? null;
		} catch (error) {
			throw new Response(
				error instanceof Error ? error.message : "Invalid schedule",
				{ status: 400 },
			);
		}
	}
	if (!data.mailboxId)
		throw new Response("Mailbox is required", { status: 403 });
	try {
		await formattedSender(user, data.mailboxId, data.from ?? "");
	} catch (error) {
		if (error instanceof MailboxAccessError) {
			const [mailbox] = await withDatabase(
				(sql) =>
					sql.SourceDraftSenderExists`SELECT id FROM mailboxes WHERE id=${data.mailboxId}`,
			);
			throw new Response(
				mailbox
					? "You do not have permission to send from this mailbox"
					: "Mailbox not found",
				{ status: 403 },
			);
		}
		if (
			error instanceof Error &&
			error.message === "Sender address is not assigned to this mailbox"
		)
			throw new Response("Sender address does not match the selected mailbox", {
				status: 403,
			});
		throw error;
	}
	return { ...data, mailboxId: data.mailboxId, scheduledAt };
}
function draftHeaders(draft: { id: string; draft_revision: number }) {
	return {
		ETag: `"${draft.draft_revision}"`,
		"X-Mailflare-Draft-Revision": String(draft.draft_revision),
		"X-Mailflare-Draft-Id": draft.id,
		"Cache-Control": "private, no-store, no-transform",
	};
}
function attachmentDto(
	file: Awaited<ReturnType<typeof getDraft>>["attachments"][number],
) {
	return {
		id: file.id,
		messageId: file.message_id,
		filename: file.filename,
		type: file.content_type,
		size: file.size,
		disposition: file.disposition === "inline" ? "inline" : "attachment",
		contentId: file.content_id,
	};
}
export async function draftsApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	try {
		return await dispatchDraftsApi(request, user);
	} catch (error) {
		if (
			error instanceof Error &&
			(error.message === "Draft not found" ||
				error.message === "Attachment not found")
		)
			return Response.json({ error: error.message }, { status: 404 });
		throw error;
	}
}
async function dispatchDraftsApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	const send = await sessionSendApi(request, user);
	if (send) return send;
	const path = new URL(request.url).pathname,
		method = request.method;
	if (path === "/api/attachment-policy" && method === "GET")
		return Response.json({
			maxMb: (await attachmentLimit()) / 1_000_000,
			cloudThresholdBytes: 3_000_000,
		});
	if (path === "/api/drafts" && method === "GET") {
		const mailboxId =
			new URL(request.url).searchParams.get("mailboxId") || null;
		const rows = await withDatabase(
			(sql) =>
				sql.SourceOwnDraftList`SELECT * FROM messages WHERE user_id=${user.id} AND direction='outbound' AND status='draft' AND (${mailboxId} IS NULL OR mailbox_id=${mailboxId}) ORDER BY created_at DESC LIMIT 100`,
		);
		return Response.json({ drafts: rows.map(toStoredSourceMessage) });
	}
	if (path === "/api/drafts" && method === "POST") {
		const data = await draftData(user, await jsonBody(request));
		if (data.forwardOfMessageId) {
			try {
				await messageRecord(user, data.forwardOfMessageId, "read");
			} catch (error) {
				if (error instanceof Error && /not found/.test(error.message))
					throw new Response("Message not found", { status: 404 });
				throw error;
			}
		}
		const draft = await saveDraft(user, data);
		return Response.json(
			{
				draft: {
					id: draft.id,
					attachments: draft.attachments.map(attachmentDto),
				},
			},
			{ headers: draftHeaders(draft) },
		);
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
			const input = await jsonBody(request);
			const draft = await getDraft(user, draftId),
				revision = expectedDraftRevision(request, draft.draft_revision);
			const [agent] = await withDatabase(
				(sql) =>
					sql.MutableDraftAgent`SELECT mailbox_id FROM agent_draft_metadata WHERE draft_id=${draftId}`,
			);
			const data = await draftData(user, input, agent);
			const saved = await saveDraft(user, { ...data, id: draftId, revision });
			return Response.json(
				{ draft: { id: saved.id } },
				{ headers: draftHeaders(saved) },
			);
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
			const files = await readDraftAttachmentFiles(request);
			if (!files.length)
				throw new Response("No attachments provided", { status: 400 });
			const maxBytes = await attachmentLimit();
			if (
				draft.attachments.length + files.length > 10 ||
				files.some((file) => file.size > maxBytes) ||
				draft.attachments.reduce((n, file) => n + file.size, 0) +
					files.reduce((n, file) => n + file.size, 0) >
					maxBytes
			)
				throw new Response(
					"Draft attachments exceed the allowed count or outgoing size limit",
					{ status: 400 },
				);
			const saved = await uploadAttachments(
				user,
				draftId,
				files,
				draft.draft_revision,
			);
			const existing = new Set(draft.attachments.map((file) => file.id));
			return Response.json(
				{
					attachments: saved.attachments
						.filter((file) => !existing.has(file.id))
						.map((file) => ({ ...attachmentDto(file), r2Key: file.r2_key })),
				},
				{ headers: draftHeaders(saved) },
			);
		}
		if (method === "DELETE" && fileId) {
			const draft = await getDraft(user, draftId);
			expectedDraftRevision(request, draft.draft_revision);
			const saved = await removeAttachment(
				user,
				draftId,
				fileId,
				draft.draft_revision,
			);
			return Response.json({ ok: true }, { headers: draftHeaders(saved) });
		}
	}
	return null;
}
