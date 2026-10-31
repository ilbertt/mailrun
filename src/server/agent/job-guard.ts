import { seconds, type AppSQL } from "../db";
import type { AgentToolContext } from "./types";
export class AutoDraftLeaseError extends Error {
	constructor() {
		super("Draft job lease changed or expired");
	}
}
export class AutoDraftStaleError extends Error {
	constructor() {
		super("Settings, source, reviewer, limit or draft job changed");
	}
}
export async function assertAutoDraftPublish(
	sql: AppSQL,
	ctx: AgentToolContext,
) {
	const proof = ctx.job;
	if (!proof) return;
	const [owned] =
		await sql.NativeAutoDraftPublishLease`SELECT id FROM agent_jobs WHERE id=${proof.id} AND status='running' AND attempts=${proof.attempt} AND lease_until=${proof.leaseUntil} AND lease_until>${seconds()}`;
	if (!owned) throw new AutoDraftLeaseError();
	const today = Math.floor(seconds() / 86400) * 86400;
	const [job] =
		await sql.NativeAutoDraftPublishGuard`SELECT j.id FROM agent_jobs j JOIN mailbox_agent_settings s ON s.mailbox_id=j.mailbox_id JOIN mailboxes b ON b.id=j.mailbox_id JOIN messages m ON m.id=j.source_message_id WHERE j.id=${proof.id} AND j.mailbox_id=${ctx.mailboxId} AND j.source_message_id=${proof.sourceMessageId} AND j.reviewer_user_id=${ctx.user.id} AND j.status='running' AND j.attempts=${proof.attempt} AND j.lease_until=${proof.leaseUntil} AND j.lease_until>${seconds()} AND s.auto_draft_enabled=1 AND coalesce(s.reviewer_user_id,b.user_id)=${ctx.user.id} AND b.auto_reply_enabled=0 AND coalesce((SELECT agent_enabled FROM app_settings WHERE id='default'),1)=1 AND m.mailbox_id=j.mailbox_id AND m.status='received' AND m.folder_id IS NULL AND m.spam_analysis_error IS NULL AND (m.spam_verdict IS NULL OR m.spam_verdict='inbox') AND NOT EXISTS(SELECT 1 FROM agent_draft_metadata a WHERE a.source_message_id=m.id) AND NOT EXISTS(SELECT 1 FROM messages n WHERE m.thread_id IS NOT NULL AND n.mailbox_id=m.mailbox_id AND n.thread_id=m.thread_id AND n.created_at>m.created_at AND (n.direction='inbound' OR (n.direction='outbound' AND n.status='sent'))) AND (SELECT count(*) FROM agent_jobs done WHERE done.mailbox_id=j.mailbox_id AND done.status='completed' AND done.created_at>=${today})<s.daily_limit`;
	if (!job) throw new AutoDraftStaleError();
}
