import { withDatabase, id, seconds } from "../db";
import { LocalStorage, deleteUnreferencedObjects } from "../storage";
import { draftLock, formattedSender } from "../mail/drafts";
import { deliverJob } from "../mail/send";
import { deliveryPayloadSchema } from "../../shared/mail-contracts";
import { buildSnippet } from "../../lib/email/parse";
import { decodeIdentityId, identityId } from "./ids";
import {
	listJmapMailboxes,
	listSendableAddresses,
	jmapMutation,
} from "./access";
import { getEmailState } from "./state";
import { loadMessages, jmapAttachments } from "./repository";
import { JmapError } from "./errors";
import type { JmapContext, JmapMethodHandler } from "./types";
export async function buildIdentities(ctx: JmapContext) {
	const list: Record<string, unknown>[] = [];
	for (const box of await listJmapMailboxes(ctx)) {
		if (box.permission === "read_only") continue;
		for (const address of await listSendableAddresses(ctx, box))
			list.push({
				id: identityId(box.id, address),
				name: box.displayName ?? "",
				email: address,
				replyTo: null,
				bcc: null,
				textSignature: "",
				htmlSignature: "",
				mayDelete: false,
			});
	}
	return list;
}
export const identityGet: JmapMethodHandler = async (ctx, args) => {
	const all = await buildIdentities(ctx),
		ids = args.ids as string[] | null | undefined,
		list = ids ? all.filter((item) => ids.includes(String(item.id))) : all,
		found = new Set(list.map((item) => item.id));
	return {
		accountId: ctx.accountId,
		state: "identities",
		list,
		notFound: ids ? ids.filter((id) => !found.has(id)) : [],
	};
};
export const identityChanges: JmapMethodHandler = async () => ({
	type: "cannotCalculateChanges",
});
export const identitySet: JmapMethodHandler = async (ctx, args) => ({
	accountId: ctx.accountId,
	oldState: "identities",
	newState: "identities",
	created: {},
	updated: {},
	destroyed: [],
	notCreated: Object.fromEntries(
		Object.keys((args.create ?? {}) as object).map((id) => [
			id,
			{ type: "forbidden" },
		]),
	),
	notUpdated: Object.fromEntries(
		Object.keys((args.update ?? {}) as object).map((id) => [
			id,
			{ type: "forbidden" },
		]),
	),
	notDestroyed: Object.fromEntries(
		((args.destroy ?? []) as string[]).map((id) => [id, { type: "forbidden" }]),
	),
});
async function submit(
	ctx: JmapContext,
	emailId: string,
	identity: { mailboxId: string; address: string },
) {
	return draftLock(emailId, async () => {
		const [draft] = await loadMessages(ctx, [emailId]);
		if (
			!draft ||
			draft.status !== "draft" ||
			draft.userId !== ctx.auth.userId ||
			draft.mailboxId !== identity.mailboxId
		)
			throw new JmapError("invalidProperties", "Not a draft of this account", {
				properties: ["emailId"],
			});
		const from = await formattedSender(
				ctx.auth.user,
				identity.mailboxId,
				identity.address,
			),
			files = (await jmapAttachments(ctx, [draft.id])).get(draft.id) ?? [];
		if (
			files.length > 10 ||
			files.reduce((sum, file) => sum + file.size, 0) > 25_000_000
		)
			throw new JmapError("tooLarge");
		const payload = deliveryPayloadSchema.parse({
			from,
			to: draft.toAddr,
			cc: draft.ccAddr ?? "",
			bcc: draft.bccAddr ?? "",
			subject: draft.subject ?? "(no subject)",
			text: draft.textBody ?? undefined,
			html: draft.htmlBody ?? undefined,
			inReplyTo: draft.inReplyTo,
			references: draft.references,
			threadId: draft.threadId,
			returnToDraft: false,
			submittedDraftId: draft.id,
		});

		const messageId = id("msg"),
			jobId = id("job"),
			storage = new LocalStorage(),
			written: string[] = [],
			attachments: typeof files = [];
		let queued = false;
		try {
			for (const file of files) {
				const attachmentId = id("att"),
					key = `attachments/${messageId}/${attachmentId}`;
				await storage.put(key, storage.file(file.r2Key));
				written.push(key);
				attachments.push({ ...file, id: attachmentId, messageId, r2Key: key });
			}
			await jmapMutation(ctx, identity.mailboxId, "write", async (sql) => {
				const [reserved] =
					await sql.NativeJmapReserveSubmission`UPDATE messages SET status='queued' WHERE id=${draft.id} AND user_id=${ctx.auth.userId} AND status='draft' AND draft_revision=${draft.draftRevision} RETURNING id`;
				if (!reserved) throw new JmapError("forbidden", "Draft changed");
				await sql.NativeJmapQueueSubmissionMessage`INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,cc_addr,bcc_addr,subject,snippet,text_body,html_body,status,read,thread_id,in_reply_to,references_header,created_at) VALUES(${messageId},${ctx.auth.userId},${identity.mailboxId},'outbound',${from},${draft.toAddr},${draft.ccAddr},${draft.bccAddr},${payload.subject},${buildSnippet(draft.textBody, draft.htmlBody)},${draft.textBody},${draft.htmlBody},'queued',1,${draft.threadId},${draft.inReplyTo},${draft.references},${seconds()})`;
				for (const file of attachments)
					await sql.NativeJmapQueueSubmissionAttachment`INSERT INTO message_attachments(id,message_id,filename,content_type,size,disposition,content_id,r2_key,created_at) VALUES(${file.id},${messageId},${file.filename},${file.contentType},${file.size},${file.disposition},${file.contentId},${file.r2Key},${seconds()})`;
				await sql.NativeJmapQueueSubmissionJob`INSERT INTO outbound_jobs(id,user_id,message_id,status,payload,created_at,updated_at) VALUES(${jobId},${ctx.auth.userId},${messageId},'queued',${JSON.stringify(payload)},${seconds()},${seconds()})`;
			});
			queued = true;
			await deliverJob(jobId, ctx.send);
			return { messageId, threadId: draft.threadId ?? messageId };
		} finally {
			if (!queued) {
				await deleteUnreferencedObjects(written);
			}
		}
	});
}
export const emailSubmissionSet: JmapMethodHandler = async (ctx, args) => {
	const oldState = await getEmailState(ctx),
		created: Record<string, unknown> = Object.create(null),
		notCreated: Record<string, unknown> = Object.create(null),
		destroyedEmails: string[] = [];
	const entries = Object.entries(
		(args.create ?? {}) as Record<string, Record<string, unknown>>,
	);
	if (entries.length > 100) throw new JmapError("requestTooLarge");
	for (const [creationId, value] of entries) {
		const emailId =
				ctx.createdIds[String(value.emailId).replace(/^#/, "")] ??
				String(value.emailId ?? ""),
			identity =
				typeof value.identityId === "string"
					? decodeIdentityId(value.identityId)
					: null,
			accessible = await listJmapMailboxes(ctx);
		if (
			!identity ||
			!accessible.some(
				(box) =>
					box.id === identity.mailboxId && box.permission !== "read_only",
			)
		) {
			notCreated[creationId] = {
				type: "invalidProperties",
				properties: ["identityId"],
			};
			continue;
		}
		try {
			const result = await submit(ctx, emailId, identity);
			destroyedEmails.push(emailId);
			ctx.createdIds[creationId] = result.messageId;
			created[creationId] = {
				id: result.messageId,
				identityId: value.identityId,
				emailId: result.messageId,
				threadId: result.threadId,
				envelope: null,
				sendAt: new Date().toISOString(),
				undoStatus: "final",
				deliveryStatus: null,
				dsnBlobIds: [],
				mdnBlobIds: [],
			};
		} catch (error) {
			notCreated[creationId] =
				error instanceof JmapError
					? error.toMethodError()
					: {
							type: "forbidden",
							description:
								error instanceof Error ? error.message : "Send failed",
						};
		}
	}
	return {
		accountId: ctx.accountId,
		oldState,
		newState: await getEmailState(ctx),
		created,
		updated: {},
		destroyed: [],
		notCreated,
		notUpdated: Object.fromEntries(
			Object.keys((args.update ?? {}) as object).map((id) => [
				id,
				{ type: "forbidden" },
			]),
		),
		notDestroyed: Object.fromEntries(
			((args.destroy ?? []) as string[]).map((id) => [
				id,
				{ type: "forbidden" },
			]),
		),
		__destroyedEmails: destroyedEmails,
	};
};
export const emailSubmissionGet: JmapMethodHandler = async (ctx, args) => ({
	accountId: ctx.accountId,
	state: await getEmailState(ctx),
	list: [],
	notFound: (args.ids ?? []) as string[],
});
export const emailSubmissionQuery: JmapMethodHandler = async (ctx) => ({
	accountId: ctx.accountId,
	queryState: await getEmailState(ctx),
	canCalculateChanges: false,
	position: 0,
	ids: [],
	total: 0,
});
export const emailSubmissionChanges: JmapMethodHandler = async () => ({
	type: "cannotCalculateChanges",
});
