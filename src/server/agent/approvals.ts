import { withDatabase, id, seconds } from "../db";
import { draftLock, getDraft, formattedSender } from "../mail/drafts";
import { deliverJob } from "../mail/send";
import { LocalStorage, deleteUnreferencedObjects } from "../storage";
import { deliveryPayloadSchema } from "../../shared/mail-contracts";
import { buildSnippet } from "../../lib/email/parse";
import { withToolMutation, requireToolAccess } from "./access";
import type { AgentToolContext } from "./types";
import type { User } from "../../shared/contracts";
import type { CloudflareFetch } from "../cloudflare/client";
export type AgentSendSnapshot = {
	from: string;
	to: string;
	cc: string | null;
	bcc: string | null;
	subject: string;
	text: string | null;
	html: string | null;
	inReplyTo: string | null;
	references: string | null;
	threadId: string | null;
	mailboxId: string;
	scheduledAt: string | null;
	attachments: { id: string; filename: string; size: number; digest: string }[];
};
const hash = (value: string) =>
	new Bun.CryptoHasher("sha256").update(value).digest("hex");
async function currentDraft(ctx: AgentToolContext, draftId: string) {
	await requireToolAccess(ctx, "send");
	const draft = await getDraft(ctx.user, draftId);
	if (!draft.mailbox_id || draft.mailbox_id !== ctx.mailboxId)
		throw new Error("Draft not found");
	const [metadata] = await withDatabase(
		(sql) =>
			sql.NativeAgentApprovalMetadata`SELECT * FROM agent_draft_metadata WHERE draft_id=${draftId} AND mailbox_id=${ctx.mailboxId}`,
	);
	if (!metadata) throw new Error("Agent draft not found");
	await formattedSender(ctx.user, ctx.mailboxId, draft.from_addr);
	return { draft, metadata };
}
async function snapshot(
	draft: Awaited<ReturnType<typeof getDraft>>,
	scheduled: number | null,
) {
	const storage = new LocalStorage(),
		attachments: AgentSendSnapshot["attachments"] = [];
	for (const row of draft.attachments) {
		const file = storage.file(row.r2_key);
		if (!(await file.exists()) || file.size !== row.size)
			throw new Error("Draft attachment missing");
		const digest = new Bun.CryptoHasher("sha256");
		for await (const chunk of file.stream()) digest.update(chunk);
		attachments.push({
			id: row.id,
			filename: row.filename,
			size: row.size,
			digest: digest.digest("hex"),
		});
	}
	attachments.sort((a, b) => a.id.localeCompare(b.id));
	const payload: AgentSendSnapshot = {
		from: draft.from_addr,
		to: draft.to_addr,
		cc: draft.cc_addr,
		bcc: draft.bcc_addr,
		subject: draft.subject ?? "",
		text: draft.text_body,
		html: draft.html_body,
		inReplyTo: draft.in_reply_to,
		references: draft.references_header,
		threadId: draft.thread_id,
		mailboxId: draft.mailbox_id!,
		scheduledAt:
			scheduled == null ? null : new Date(scheduled * 1000).toISOString(),
		attachments,
	};
	if (
		!payload.to.trim() ||
		!payload.subject.trim() ||
		!(payload.text?.trim() || payload.html?.trim())
	)
		throw new Error("Draft is incomplete");
	return { payload, hash: hash(JSON.stringify(payload)) };
}
export async function requestAgentSend(
	ctx: AgentToolContext,
	draftId: string,
	expectedRevision: number,
	requestKeyId?: string,
) {
	return draftLock(draftId, async () => {
		const { draft, metadata } = await currentDraft(ctx, draftId);
		if (metadata.revision !== expectedRevision)
			throw new Error("Draft changed; reopen it for review");
		if (
			metadata.scheduled_at != null &&
			metadata.scheduled_at * 1000 <= Date.now()
		)
			throw new Error(
				"Scheduled time has passed; update the draft before review",
			);
		const read = await snapshot(draft, metadata.scheduled_at),
			approvalId = id("approval"),
			expires = seconds() + 15 * 60;
		await withToolMutation(ctx, "send", async (sql) => {
			const [blocked] =
				await sql.NativeAgentApprovalInProgress`SELECT id FROM agent_send_approvals WHERE draft_id=${draftId} AND status IN('claimed','sent','unknown') LIMIT 1`;
			if (blocked)
				throw new Error(
					"This draft has a delivery already in progress or awaiting reconciliation",
				);
			const [current] =
				await sql.NativeAgentApprovalSnapshotGuard`SELECT m.id FROM messages m JOIN agent_draft_metadata a ON a.draft_id=m.id WHERE m.id=${draftId} AND m.user_id=${ctx.user.id} AND m.mailbox_id=${ctx.mailboxId} AND m.status='draft' AND m.draft_revision=${draft.draft_revision} AND a.revision=${expectedRevision}`;
			if (!current) throw new Error("Draft changed; reopen it for review");
			if (requestKeyId) {
				// A request key is always bound explicitly to the authenticated MCP context.
				const [key] =
					await sql.NativeAgentApprovalRequestKey`SELECT id FROM api_keys WHERE id=${requestKeyId} AND user_id=${ctx.user.id} AND kind='mcp'`;
				if (!key) throw new Error("Permission denied");
			}
			await sql.NativeAgentCreateApproval`INSERT INTO agent_send_approvals(id,draft_id,mailbox_id,user_id,request_key_id,revision,payload_hash,status,expires_at,created_at) VALUES(${approvalId},${draftId},${ctx.mailboxId},${ctx.user.id},${requestKeyId ?? null},${expectedRevision},${read.hash},'pending',${expires},${seconds()})`;
		});
		return {
			approvalId,
			status: "pending_approval",
			expiresAt: new Date(expires * 1000),
			snapshot: read.payload,
			reviewUrl: `/agent/review/${approvalId}`,
		};
	});
}
export async function getAgentSendRequest(user: User, approvalId: string) {
	const [approval] = await withDatabase(
		(sql) =>
			sql.NativeAgentGetApproval`SELECT * FROM agent_send_approvals WHERE id=${approvalId} AND user_id=${user.id}`,
	);
	if (!approval) throw new Error("Approval not found");
	let current: AgentSendSnapshot | null = null,
		stale = false;
	if (approval.status === "pending") {
		try {
			const { draft, metadata } = await currentDraft(
					{ user, mailboxId: approval.mailbox_id, origin: "chat" },
					approval.draft_id,
				),
				read = await snapshot(draft, metadata.scheduled_at);
			stale =
				metadata.revision !== approval.revision ||
				read.hash !== approval.payload_hash ||
				!!(
					metadata.scheduled_at != null &&
					metadata.scheduled_at * 1000 <= Date.now()
				);
			if (!stale) current = read.payload;
		} catch {
			stale = true;
		}
	}
	return {
		approvalId,
		status: approval.status,
		draftId: approval.draft_id,
		messageId: approval.message_id,
		expiresAt: new Date(approval.expires_at * 1000),
		snapshot: current,
		stale,
	};
}
export async function confirmAgentSend(
	user: User,
	approvalId: string,
	send: CloudflareFetch = fetch,
) {
	const [first] = await withDatabase(
		(sql) =>
			sql.NativeAgentConfirmLookup`SELECT * FROM agent_send_approvals WHERE id=${approvalId} AND user_id=${user.id}`,
	);
	if (!first) throw new Error("Approval not found");
	if (first.status !== "pending")
		return { status: first.status, messageId: first.message_id };
	const queued = await draftLock(first.draft_id, async () => {
		const [approval] = await withDatabase(
			(sql) =>
				sql.NativeAgentConfirmCurrent`SELECT * FROM agent_send_approvals WHERE id=${approvalId} AND user_id=${user.id}`,
		);
		if (!approval) throw new Error("Approval not found");
		if (approval.status !== "pending")
			return { status: approval.status, messageId: approval.message_id };
		if (approval.expires_at < seconds()) {
			await withDatabase(
				(sql) =>
					sql.NativeAgentExpireApproval`UPDATE agent_send_approvals SET status='expired' WHERE id=${approvalId} AND status='pending'`,
			);
			throw new Error("Approval expired");
		}
		const ctx: AgentToolContext = {
				user,
				mailboxId: approval.mailbox_id,
				origin: "chat",
			},
			{ draft, metadata } = await currentDraft(ctx, approval.draft_id),
			read = await snapshot(draft, metadata.scheduled_at);
		if (
			metadata.revision !== approval.revision ||
			read.hash !== approval.payload_hash
		)
			throw new Error("Draft changed; review it again");
		if (
			metadata.scheduled_at != null &&
			metadata.scheduled_at * 1000 <= Date.now()
		)
			throw new Error(
				"Scheduled time has passed; update the draft before confirming",
			);
		const scheduled = metadata.scheduled_at != null,
			now = seconds(),
			messageId = id("msg"),
			jobId = id("job"),
			storage = new LocalStorage(),
			written: string[] = [],
			files: {
				id: string;
				key: string;
				file: (typeof draft.attachments)[number];
			}[] = [];
		const payload = deliveryPayloadSchema.parse({
			from: read.payload.from,
			to: read.payload.to,
			cc: read.payload.cc ?? "",
			bcc: read.payload.bcc ?? "",
			subject: read.payload.subject,
			text: read.payload.text ?? undefined,
			html: read.payload.html ?? undefined,
			inReplyTo: read.payload.inReplyTo,
			references: read.payload.references,
			threadId: read.payload.threadId,
			returnToDraft: false,
			submittedDraftId: scheduled ? undefined : draft.id,
			retainSubmittedDraft: true,
			approvalId,
		});
		let committed = false;
		try {
			for (const file of draft.attachments) {
				const aid = id("att"),
					key = `attachments/${messageId}/${aid}`;
				await storage.put(key, storage.file(file.r2_key));
				written.push(key);
				files.push({ id: aid, key, file });
			}
			await withToolMutation(ctx, "send", async (sql) => {
				const [claim] =
					await sql.NativeAgentClaimApproval`UPDATE agent_send_approvals SET status=${scheduled ? "sent" : "claimed"},claimed_at=${now},message_id=${messageId} WHERE id=${approvalId} AND user_id=${user.id} AND status='pending' AND expires_at>=${seconds()} RETURNING id`;
				if (!claim)
					throw new Error("Approval is unavailable or already processed");
				const [reserved] =
					await sql.NativeAgentReserveApprovedDraft`UPDATE messages SET status=${scheduled ? "trash" : "queued"},trashed_at=${scheduled ? now : null} WHERE id=${draft.id} AND user_id=${user.id} AND mailbox_id=${ctx.mailboxId} AND status='draft' AND draft_revision=${draft.draft_revision} AND EXISTS(SELECT 1 FROM agent_draft_metadata WHERE draft_id=messages.id AND revision=${approval.revision}) RETURNING id`;
				if (!reserved) throw new Error("Draft changed; review it again");
				await sql.NativeAgentQueueApprovedMessage`INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,cc_addr,bcc_addr,subject,text_body,html_body,snippet,status,read,thread_id,in_reply_to,references_header,created_at) VALUES(${messageId},${user.id},${ctx.mailboxId},'outbound',${read.payload.from},${read.payload.to},${read.payload.cc},${read.payload.bcc},${read.payload.subject},${read.payload.text},${read.payload.html},${buildSnippet(read.payload.text, read.payload.html)},'queued',1,${read.payload.threadId},${read.payload.inReplyTo},${read.payload.references},${now})`;
				for (const entry of files)
					await sql.NativeAgentQueueApprovedAttachment`INSERT INTO message_attachments(id,message_id,filename,content_type,size,disposition,content_id,r2_key,created_at) VALUES(${entry.id},${messageId},${entry.file.filename},${entry.file.content_type},${entry.file.size},${entry.file.disposition},${entry.file.content_id},${entry.key},${now})`;
				await sql.NativeAgentQueueApprovedJob`INSERT INTO outbound_jobs(id,user_id,message_id,status,payload,scheduled_at,created_at,updated_at) VALUES(${jobId},${user.id},${messageId},'queued',${JSON.stringify(payload)},${metadata.scheduled_at},${now},${now})`;
			});
			committed = true;
			return { status: "sent", messageId, jobId, scheduled };
		} finally {
			if (!committed) await deleteUnreferencedObjects(written);
		}
	});
	if ("jobId" in queued && !queued.scheduled) {
		try {
			await deliverJob(queued.jobId!, send);
		} catch (error) {
			throw new Error(
				`Delivery outcome needs review: ${error instanceof Error ? error.message : "provider error"}`,
			);
		}
	}
	return {
		status: queued.status,
		messageId: queued.messageId,
		...("scheduled" in queued ? { scheduled: queued.scheduled } : {}),
	};
}
