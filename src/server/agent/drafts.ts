import { assertAutoDraftPublish } from "./job-guard";
import { withDatabase, id, seconds, type AppSQL } from "../db";
import {
	draftLock,
	formattedSender,
	getDraft,
	attachmentLimit,
} from "../mail/drafts";
import { buildSnippet } from "../../lib/email/parse";
import {
	buildReplyReferences,
	formatMessageIdHeader,
	parseMessageIdList,
} from "../../lib/email/threading";
import {
	getEmailAddress,
	splitEmailAddressList,
} from "../../lib/email/address";
import { LocalStorage, deleteUnreferencedObjects } from "../storage";
import { withToolMutation, requireToolAccess } from "./access";
import { ownToolMessage, type AgentMessage } from "./messages";
import { formatAgentDraftBody } from "./draft-format";
import { parseAgentScheduledAt } from "./schedule";
import type { AgentToolContext, AgentDraftEditInput } from "./types";
export async function createAgentDraft(
	ctx: AgentToolContext,
	input: {
		to: string;
		cc?: string;
		subject: string;
		body: string;
		source?: AgentMessage;
	},
) {
	const box = await requireToolAccess(ctx, "send"),
		formatted = formatAgentDraftBody(input.body);
	if (!formatted.text) throw new Error("Draft body is empty");
	const from = await formattedSender(
		ctx.user,
		ctx.mailboxId,
		`${box.local_part}@${box.hostname}`,
	);
	const source = input.source,
		refs = source
			? buildReplyReferences(
					parseMessageIdList(source.references_header),
					source.provider_message_id,
				)
			: [],
		draftId = id("msg");
	await withToolMutation(ctx, "send", async (sql) => {
		await assertAutoDraftPublish(sql, ctx);
		await sql.NativeCreateAgentDraft`INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,cc_addr,subject,text_body,html_body,snippet,status,read,in_reply_to,references_header,thread_id,created_at) VALUES(${draftId},${ctx.user.id},${ctx.mailboxId},'outbound',${from},${input.to},${input.cc || null},${input.subject},${formatted.text},${formatted.html},${buildSnippet(formatted.text, null)},'draft',1,${source?.provider_message_id ?? null},${refs.length ? formatMessageIdHeader(refs) : null},${source?.thread_id ?? null},${seconds()})`;
		await sql.NativeCreateAgentDraftMetadata`INSERT INTO agent_draft_metadata(draft_id,mailbox_id,origin,source_message_id,revision,created_at) VALUES(${draftId},${ctx.mailboxId},${ctx.origin},${source?.id ?? null},1,${seconds()})`;
		if (ctx.job)
			await sql.NativeCompletePublishedAutoDraft`UPDATE agent_jobs SET status='completed',draft_id=${draftId},lease_until=NULL,reason=NULL WHERE id=${ctx.job.id} AND status='running' AND attempts=${ctx.job.attempt} AND lease_until=${ctx.job.leaseUntil}`;
	});
	return {
		draftId,
		revision: 1,
		sourceMessageId: source?.id ?? null,
		status: "draft_created",
		composerUrl: `/drafts/${draftId}`,
	};
}
function recipients(value: string, label: string, required: boolean) {
	const entries = splitEmailAddressList(value);
	if (required && !entries.length)
		throw new Error(`${label} needs at least one address`);
	if (
		entries.some(
			(entry) =>
				/[\r\n]/.test(entry) ||
				!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(getEmailAddress(entry)),
		)
	)
		throw new Error(`${label} contains an invalid address`);
	return entries.join(", ");
}
export async function editAgentDraft(
	ctx: AgentToolContext,
	input: AgentDraftEditInput,
) {
	if (
		![
			input.from,
			input.to,
			input.cc,
			input.bcc,
			input.subject,
			input.body,
			input.scheduledAt,
			input.addAttachments?.length,
			input.removeAttachmentIds?.length,
		].some((value) => value !== undefined && value !== 0)
	)
		throw new Error("Provide at least one draft change");
	return draftLock(input.draftId, async () => {
		await requireToolAccess(ctx, "send");
		const draft = await getDraft(ctx.user, input.draftId);
		if (draft.mailbox_id !== ctx.mailboxId)
			throw new Error("Draft not found in the selected mailbox");
		const [meta] = await withDatabase(
			(sql) =>
				sql.NativeAgentEditMetadata`SELECT * FROM agent_draft_metadata WHERE draft_id=${draft.id} AND mailbox_id=${ctx.mailboxId}`,
		);
		if (!meta) throw new Error("This draft was not created by the assistant");
		if (meta.revision !== input.expectedRevision)
			throw new Error("Draft changed; read it again before editing");
		const from =
				input.from === undefined
					? draft.from_addr
					: await formattedSender(ctx.user, ctx.mailboxId, input.from),
			to =
				input.to === undefined
					? draft.to_addr
					: recipients(input.to, "To", true),
			cc =
				input.cc === undefined
					? draft.cc_addr
					: input.cc === null
						? null
						: recipients(input.cc, "Cc", false) || null,
			bcc =
				input.bcc === undefined
					? draft.bcc_addr
					: input.bcc === null
						? null
						: recipients(input.bcc, "Bcc", false) || null,
			body = input.body === undefined ? null : formatAgentDraftBody(input.body),
			scheduled =
				input.scheduledAt === undefined
					? undefined
					: parseAgentScheduledAt(input.scheduledAt);
		if (/[\r\n]/.test(input.subject ?? ""))
			throw new Error("Invalid email header");
		const removals = new Set(input.removeAttachmentIds ?? []),
			existing = draft.attachments;
		if (
			[...removals].some((value) => !existing.some((file) => file.id === value))
		)
			throw new Error("Attachment to remove was not found on this draft");
		const remaining = existing.filter((file) => !removals.has(file.id)),
			storage = new LocalStorage();
		const additions: {
				id: string;
				key: string;
				filename: string;
				contentType: string;
				size: number;
				sourceId: string;
				sourceMessageId: string;
				sourceKey: string;
			}[] = [],
			written: string[] = [];
		let committed = false;
		try {
			for (const item of input.addAttachments ?? []) {
				await ownToolMessage(ctx, item.sourceEmailId);
				const [file] = await withDatabase(
					(sql) =>
						sql.NativeAgentAttachmentSource`SELECT * FROM message_attachments WHERE id=${item.attachmentId} AND message_id=${item.sourceEmailId} AND disposition='attachment' AND trashed_at IS NULL`,
				);
				if (!file) throw new Error("Attachment not found on the source email");
				const aid = id("att"),
					key = `attachments/${draft.id}/${aid}`,
					source = storage.file(file.r2_key);
				if (!(await source.exists()) || source.size !== file.size)
					throw new Error("Draft attachment missing");
				if (
					remaining.length + additions.length + 1 > 10 ||
					remaining.reduce((n, x) => n + x.size, 0) +
						additions.reduce((n, x) => n + x.size, 0) +
						file.size >
						(await attachmentLimit())
				)
					throw new Error(
						"Draft attachments exceed the allowed count or total size",
					);
				await storage.put(key, source);
				written.push(key);
				additions.push({
					id: aid,
					key,
					filename: file.filename,
					contentType: file.content_type,
					size: file.size,
					sourceId: file.id,
					sourceMessageId: item.sourceEmailId,
					sourceKey: file.r2_key,
				});
			}
			const result = await withToolMutation(ctx, "send", async (sql) => {
				const [updated] =
					await sql.NativeAgentEditGuard`UPDATE messages SET from_addr=${from},to_addr=${to},cc_addr=${cc},bcc_addr=${bcc},subject=${input.subject ?? draft.subject},text_body=${body?.text ?? draft.text_body},html_body=${body?.html ?? draft.html_body},snippet=${body ? buildSnippet(body.text, null) : draft.snippet},draft_scheduled_at=${scheduled === undefined ? meta.scheduled_at : scheduled ? Math.floor(scheduled.getTime() / 1000) : null},draft_revision=draft_revision+1 WHERE id=${draft.id} AND user_id=${ctx.user.id} AND mailbox_id=${ctx.mailboxId} AND status='draft' AND draft_revision=${draft.draft_revision} AND EXISTS(SELECT 1 FROM agent_draft_metadata WHERE draft_id=messages.id AND revision=${input.expectedRevision}) RETURNING id`;
				if (!updated)
					throw new Error("Draft changed; read it again before editing");
				const [metadata] =
					await sql.NativeAgentEditRevision`UPDATE agent_draft_metadata SET revision=revision+1,scheduled_at=${scheduled === undefined ? meta.scheduled_at : scheduled ? Math.floor(scheduled.getTime() / 1000) : null} WHERE draft_id=${draft.id} AND revision=${input.expectedRevision} RETURNING revision,scheduled_at`;
				if (!metadata)
					throw new Error("Draft changed; read it again before editing");
				for (const file of additions) {
					const [source] =
						await sql.NativeAgentCopySourceGuard`SELECT a.id FROM message_attachments a JOIN messages m ON m.id=a.message_id WHERE a.id=${file.sourceId} AND m.id=${file.sourceMessageId} AND m.mailbox_id=${ctx.mailboxId} AND (m.status!='draft' OR m.user_id=${ctx.user.id}) AND a.r2_key=${file.sourceKey} AND a.trashed_at IS NULL`;
					if (!source) throw new Error("Attachment source changed");
					await sql.NativeAgentCopyAttachment`INSERT INTO message_attachments(id,message_id,filename,content_type,size,disposition,r2_key,created_at) VALUES(${file.id},${draft.id},${file.filename},${file.contentType},${file.size},'attachment',${file.key},${seconds()})`;
				}
				await sql.NativeAgentRemoveAttachments`DELETE FROM message_attachments WHERE message_id=${draft.id} AND id IN(SELECT value FROM json_each(${JSON.stringify([...removals])}))`;
				return metadata;
			});
			committed = true;
			await deleteUnreferencedObjects(
				existing
					.filter((file) => removals.has(file.id))
					.map((file) => file.r2_key),
			).catch((error) =>
				console.warn("Agent attachment cleanup failed", error),
			);
			return {
				draftId: draft.id,
				revision: result.revision,
				status: "draft_updated",
				scheduledAt:
					result.scheduled_at == null
						? null
						: new Date(result.scheduled_at * 1000).toISOString(),
				composerUrl: `/drafts/${encodeURIComponent(draft.id)}`,
				attachmentCount: remaining.length + additions.length,
			};
		} finally {
			if (!committed) await deleteUnreferencedObjects(written);
		}
	});
}
export async function discardAgentDraft(
	ctx: AgentToolContext,
	draftId: string,
	revision: number,
) {
	return draftLock(draftId, async () => {
		await requireToolAccess(ctx, "send");
		const row = await ownToolMessage(ctx, draftId);
		const keys = await withToolMutation(ctx, "send", (sql) =>
			discardAgentDraftRows(sql, ctx, draftId, revision),
		);
		await deleteUnreferencedObjects(keys);
		return { draftId: row.id, status: "discarded" };
	});
}

export async function discardAgentDraftRows(
	sql: AppSQL,
	ctx: AgentToolContext,
	draftId: string,
	revision: number,
) {
	const [draft] =
		await sql.NativeAgentDiscardGuard`SELECT m.raw_r2_key FROM messages m JOIN agent_draft_metadata a ON a.draft_id=m.id WHERE m.id=${draftId} AND m.mailbox_id=${ctx.mailboxId} AND m.user_id=${ctx.user.id} AND m.status='draft' AND a.revision=${revision} AND a.human_edited_at IS NULL`;
	if (!draft) throw new Error("Draft changed or cannot be discarded");
	const files =
		await sql.NativeAgentDiscardFiles`SELECT r2_key FROM message_attachments WHERE message_id=${draftId}`;
	await sql.NativeAgentDiscard`DELETE FROM messages WHERE id=${draftId}`;
	return [
		...files.map((file) => file.r2_key),
		...(draft.raw_r2_key ? [draft.raw_r2_key] : []),
	];
}
