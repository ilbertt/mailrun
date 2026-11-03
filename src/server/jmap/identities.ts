import { LocalStorage } from "../storage";
import { draftLock } from "../mail/drafts";
import { withDatabase } from "../db";
import {
	sourceSendSender,
	queueSourceSend,
	type SourceSendAttachment,
} from "../mail/session-send";
import { assertApiPrincipal } from "../auth/key-principal";
import { awaitSubmissionOutcome } from "../mail/submission-drafts";
import { deliverJob } from "../mail/send";
import { decodeIdentityId, identityId } from "./ids";
import { listJmapMailboxMetadata, listSendableAddresses } from "./access";
import { getEmailState } from "./state";
import { loadMessages, jmapAttachments } from "./repository";
import { JmapError } from "./errors";
import type { JmapContext, JmapMethodHandler } from "./types";
export async function buildIdentities(ctx: JmapContext) {
	const list: Record<string, unknown>[] = [];
	for (const box of await listJmapMailboxMetadata(ctx)) {
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
	readableGrant: boolean,
) {
	return draftLock(emailId, async () => {
		if (!readableGrant) {
			// Source metadata can carry an unknown historical grant. Preserve its
			// validation response while requiring send authorization before body access.
			const [metadata] = await withDatabase(
				(sql) =>
					sql.SourceJmapDraftMetadata`SELECT id,user_id,mailbox_id,status FROM messages WHERE id=${emailId}`,
			);
			if (
				!metadata ||
				metadata.status !== "draft" ||
				metadata.user_id !== ctx.auth.userId ||
				metadata.mailbox_id !== identity.mailboxId
			)
				throw new JmapError(
					"invalidProperties",
					"Not a draft of this account",
					{ properties: ["emailId"] },
				);
			await sourceSendSender(
				ctx.auth.user,
				identity.mailboxId,
				identity.address,
			);
		}
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
		const files: SourceSendAttachment[] = [];
		for (const file of (await jmapAttachments(ctx, [draft.id])).get(draft.id) ??
			[]) {
			const blob = new LocalStorage().file(file.r2Key);
			if (await blob.exists())
				files.push({
					filename: file.filename,
					type: file.contentType,
					blob,
					disposition: file.disposition === "inline" ? "inline" : "attachment",
					contentId: file.contentId,
				});
		}
		const queued = await queueSourceSend(
			ctx.auth.user,
			{
				from: identity.address,
				to: draft.toAddr,
				cc: draft.ccAddr ?? undefined,
				bcc: draft.bccAddr ?? undefined,
				subject: draft.subject ?? "(no subject)",
				text: draft.textBody ?? undefined,
				html: draft.htmlBody ?? undefined,
				inReplyTo: draft.inReplyTo,
				references: draft.references,
				threadId: draft.threadId,
				mailboxId: identity.mailboxId,
			},
			files,
			ctx.origin,
			undefined,
			async (sql) => {
				await assertApiPrincipal(sql, ctx.actor, identity.mailboxId);
				const [current] =
					await sql.SourceJmapSubmissionDraft`SELECT id FROM messages WHERE id=${draft.id} AND user_id=${ctx.auth.userId} AND mailbox_id=${identity.mailboxId} AND status='draft' AND draft_revision=${draft.draftRevision} AND NOT EXISTS(SELECT 1 FROM mailrun_submission_drafts s JOIN outbound_jobs j ON j.id=s.job_id WHERE s.draft_id=messages.id AND j.status IN('queued','sending','sent'))`;
				if (!current) throw new JmapError("forbidden", "Draft changed");
			},
			async (sql, publication) => {
				await sql.ReserveSourceJmapDraft`INSERT INTO mailrun_submission_drafts(job_id,draft_id,draft_revision) VALUES(${publication.jobId},${draft.id},${draft.draftRevision})`;
			},
		);
		await deliverJob(queued.jobId, ctx.send);
		await awaitSubmissionOutcome(queued.jobId);
		return {
			messageId: queued.messageId,
			threadId: draft.threadId ?? queued.messageId,
		};
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
			accessible = await listJmapMailboxMetadata(ctx);
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
			const box = accessible.find((box) => box.id === identity.mailboxId);
			const result = await submit(
				ctx,
				emailId,
				identity,
				!!box &&
					["send_as", "send_on_behalf", "full_access"].includes(box.permission),
			);
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
								error instanceof Response
									? await error.text()
									: error instanceof Error
										? error.message
										: "Send failed",
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
