import { z } from "zod";
import type { User } from "../../shared/contracts";
import { userSchema } from "../../shared/contracts";
import { sendEmailSchema } from "../../lib/validators";
import { getEmailAddressList } from "../../lib/email/address";
import {
	normalizeMessageId,
	parseMessageIdList,
} from "../../lib/email/threading";
import { buildSnippet } from "../../lib/email/parse";
import { withDatabase, id, seconds } from "../db";
import { mailboxAccess, MailboxAccessError } from "./access";
import {
	getDraft,
	draftLock,
	formattedSender,
	attachmentLimit,
} from "./drafts";
import { LocalStorage, deleteUnreferencedObjects } from "../storage";
import { upsertContact } from "./contacts";
import { deliveryPayloadSchema } from "../../shared/mail-contracts";
import { deliveryHeaders } from "./delivery-headers";
type Input = Omit<z.output<typeof sendEmailSchema>, "attachments">;
type FileInput = {
	filename: string;
	type: string;
	blob: Blob;
	disposition: "attachment" | "inline";
	contentId?: string | null;
};
const recipients = (values: string[] | undefined) => {
	const seen = new Set<string>();
	return (values ?? [])
		.filter((value) => {
			const address = getEmailAddressList(value)[0];
			if (!address || seen.has(address)) return false;
			seen.add(address);
			return true;
		})
		.map((value) => value.trim());
};
export async function sourceSendSender(
	user: User,
	mailboxId: string,
	from: string,
) {
	const [box] = await withDatabase(
		(sql) =>
			sql.SourceSendMailboxExists`SELECT b.id FROM mailboxes b JOIN domains d ON d.id=b.domain_id JOIN users u ON u.id=b.user_id WHERE b.id=${mailboxId}`,
	);
	if (!box) throw new Response("Mailbox not found", { status: 403 });
	const [actor] = await withDatabase(
		(sql) =>
			sql.SourceSendActor`SELECT id,email,name,role,is_primary_admin FROM users WHERE id=${user.id} AND disabled=0`,
	);
	if (!actor) throw new Response("Sender account not found", { status: 403 });
	const current = userSchema.parse({
		...actor,
		isPrimaryAdmin: !!actor.is_primary_admin,
	});
	try {
		return await formattedSender(current, mailboxId, from);
	} catch (error) {
		if (error instanceof MailboxAccessError)
			throw new Response(
				"You do not have permission to send from this mailbox",
				{ status: 403 },
			);
		if (
			error instanceof Error &&
			error.message === "Sender address is not assigned to this mailbox"
		)
			throw new Response("Sender address does not match the selected mailbox", {
				status: 403,
			});
		throw error;
	}
}
export async function queueSessionSend(
	user: User,
	input: Input,
	files: File[],
	origin: string,
	draft?: { id: string; revision: number },
) {
	const run = async () => {
		const current = draft ? await getDraft(user, draft.id) : undefined;
		if (current && current.draft_revision !== draft?.revision)
			throw new Response(
				"This draft changed in another tab. Reopen it before saving.",
				{ status: 409 },
			);
		const from = await sourceSendSender(user, input.mailboxId, input.from),
			storage = new LocalStorage();
		const attachments: FileInput[] = files.map((file) => ({
			filename: file.name,
			type: file.type || "application/octet-stream",
			blob: file,
			disposition: "attachment",
		}));
		for (const file of current?.attachments ?? []) {
			const blob = storage.file(file.r2_key);
			if (!(await blob.exists())) continue;
			attachments.push({
				filename: file.filename,
				type: file.content_type,
				blob,
				disposition: file.disposition === "inline" ? "inline" : "attachment",
				contentId: file.content_id,
			});
		}
		if (attachments.length > 10)
			throw new Error("A message can include at most 10 attachments");
		let total = 0;
		for (const file of attachments) {
			if (file.blob.size > 25_000_000)
				throw new Error(file.filename + " exceeds the 25 MB attachment limit");
			total += file.blob.size;
		}
		if (total > 25_000_000)
			throw new Error("Attachments exceed the 25 MB total limit");
		const limit = await attachmentLimit();
		if (attachments.some((file) => file.blob.size > limit) || total > limit)
			throw new Error(
				`Attachments exceed the administrator's ${limit / 1_000_000} MB outgoing limit`,
			);
		const to = recipients(input.to),
			cc = recipients(input.cc),
			bcc = recipients(input.bcc);
		if (!to.length) throw new Error("At least one recipient is required");
		if (to.length + cc.length + bcc.length > 50)
			throw new Error("A message can have at most 50 recipients");
		for (const address of [...to, ...cc, ...bcc])
			await upsertContact(user.id, address, "outbound", input.mailboxId);
		const parent = normalizeMessageId(input.inReplyTo),
			references = parseMessageIdList(input.references);
		deliveryHeaders({ inReplyTo: parent, references });
		const checked = deliveryPayloadSchema.parse({
			from,
			to,
			cc,
			bcc,
			subject: input.subject,
			text: input.text,
			html: input.html,
			inReplyTo: parent,
			references: references.join(" ") || null,
			threadId: input.threadId ?? null,
		});
		deliveryHeaders(checked);
		const messageId = id("msg"),
			jobId = id("job"),
			written: string[] = [];
		const stored: {
			id: string;
			key: string;
			filename: string;
			type: string;
			size: number;
			disposition: "inline" | "attachment";
			contentId?: string | null;
			originalName: string;
		}[] = [];
		let committed = false;
		try {
			for (const file of attachments) {
				const attachmentId = id("att"),
					filename =
						file.filename.trim().replace(/[/\\\0]/g, "_") || "attachment",
					key = `attachments/${messageId}/${attachmentId}/${filename}`;
				await storage.put(key, file.blob);
				written.push(key);
				stored.push({
					id: attachmentId,
					key,
					filename,
					type: file.type,
					size: file.blob.size,
					disposition: file.disposition,
					...(file.contentId !== undefined
						? { contentId: file.contentId }
						: {}),
					originalName: file.filename,
				});
			}
			const requested = input.scheduledAt
					? Date.parse(input.scheduledAt)
					: null,
				scheduled = requested !== null && requested > Date.now(),
				scheduledAt = scheduled ? Math.floor(requested / 1000) : null;
			const payload = {
				userId: user.id,
				...input,
				from,
				to,
				cc,
				bcc,
				attachments: stored.map((file) => ({
					storageId: file.id,
					filename: file.originalName,
					type: file.type,
					disposition: file.disposition,
					...(file.contentId !== undefined
						? { contentId: file.contentId }
						: {}),
				})),
				publicOrigin: origin,
			};
			let revision: number | undefined;
			await withDatabase((sql) =>
				sql.begin(async (sql) => {
					await sql.SourceSessionSendFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
					await mailboxAccess(user, input.mailboxId, "send", sql);
					if (draft) {
						const [touched] =
							await sql.SourceTouchSubmittedDraft`UPDATE messages SET draft_revision=draft_revision+1 WHERE id=${draft.id} AND user_id=${user.id} AND status='draft' AND draft_revision=${draft.revision} RETURNING draft_revision`;
						if (!touched)
							throw new Response(
								"This draft changed in another tab. Reopen it before saving.",
								{ status: 409 },
							);
						revision = touched.draft_revision;
					}
					await sql.SourceSessionSendMessage`INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,cc_addr,bcc_addr,subject,snippet,text_body,html_body,status,read,thread_id,in_reply_to,references_header,created_at) VALUES(${messageId},${user.id},${input.mailboxId},'outbound',${from},${to.join(", ")},${cc.length ? cc.join(", ") : null},${bcc.length ? bcc.join(", ") : null},${input.subject},${buildSnippet(input.text ?? null, input.html ?? null)},${input.text ?? null},${input.html ?? null},'queued',1,${input.threadId ?? null},${parent},${references.length ? references.join(" ") : null},${seconds()})`;
					for (const file of stored)
						await sql.SourceSessionSendFile`INSERT INTO message_attachments(id,message_id,filename,content_type,size,disposition,content_id,r2_key,created_at) VALUES(${file.id},${messageId},${file.filename},${file.type},${file.size},${file.disposition},${file.contentId ?? null},${file.key},${seconds()})`;
					await sql.SourceSessionSendJob`INSERT INTO outbound_jobs(id,user_id,message_id,status,payload,scheduled_at,created_at,updated_at) VALUES(${jobId},${user.id},${messageId},'queued',${JSON.stringify(payload)},${scheduledAt},${seconds()},${seconds()})`;
				}),
			);
			committed = true;
			return {
				messageId,
				jobId,
				scheduled,
				draft:
					draft && revision !== undefined
						? { id: draft.id, revision }
						: undefined,
			};
		} finally {
			if (!committed) await deleteUnreferencedObjects(written);
		}
	};
	return draft ? draftLock(draft.id, run) : run();
}
export async function cancelSessionSend(user: User, messageId: string) {
	return draftLock(messageId, () =>
		withDatabase((sql) =>
			sql.begin(async (sql) => {
				await sql.SourceCancelSendFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
				const [message] =
					await sql.SourceCancelMessage`SELECT id,mailbox_id,direction,status FROM messages WHERE id=${messageId}`;
				if (!message?.mailbox_id)
					throw new Response("Message not found", { status: 404 });
				let access;
				try {
					access = await mailboxAccess(user, message.mailbox_id, "read", sql);
				} catch (error) {
					if (error instanceof MailboxAccessError)
						throw new Response("Message not found", { status: 404 });
					throw error;
				}
				if (
					!["send_as", "send_on_behalf", "full_access"].includes(
						typeof access.permission === "string" ? access.permission : "",
					)
				)
					throw new Response("You cannot cancel sends from this mailbox", {
						status: 403,
					});
				const [scheduled] =
					await sql.SourceScheduledJob`SELECT id FROM outbound_jobs WHERE message_id=${messageId} AND status='queued' AND scheduled_at IS NOT NULL LIMIT 1`;
				if (
					message.direction !== "outbound" ||
					message.status !== "queued" ||
					!scheduled
				)
					throw new Response("This message is not scheduled", { status: 409 });
				const deleted =
					await sql.CancelScheduledJob`DELETE FROM outbound_jobs WHERE message_id=${messageId} AND status='queued' AND scheduled_at IS NOT NULL RETURNING id`;
				if (!deleted.length)
					throw new Response("This message is already being sent", {
						status: 409,
					});
				await sql.ReturnScheduledToDraft`UPDATE messages SET status='draft',draft_scheduled_at=NULL,draft_revision=draft_revision+1 WHERE id=${messageId} AND status='queued'`;
				return { ok: true };
			}),
		),
	);
}
