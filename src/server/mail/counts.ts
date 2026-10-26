import type { User } from "../../shared/contracts";
import { withDatabase } from "../db";
import { listMailboxes } from "./repository";
import { buildMessageCounts } from "../../app/api/messages/counts/utils";
export async function sourceCounts(user: User, mailboxId?: string) {
	const mailboxes = await listMailboxes(user);
	if (mailboxId && !mailboxes.some((mailbox) => mailbox.id === mailboxId))
		throw new Response("Mailbox not found", { status: 404 });
	const scope = JSON.stringify(
		mailboxId ? [mailboxId] : mailboxes.map((mailbox) => mailbox.id),
	);
	const rows = await withDatabase(
		(sql) => sql.SourceMessageCounts`
 SELECT m.mailbox_id,m.folder_id,m.direction,m.status,m.read,m.starred,m.snoozed_until,count(*) AS total FROM messages m
 WHERE (m.mailbox_id IN(SELECT value FROM json_each(${scope})) OR (${!mailboxId && !mailboxes.length ? 1 : 0}=1 AND m.user_id=${user.id})) AND (m.status!='draft' OR m.user_id=${user.id})
 GROUP BY m.mailbox_id,m.folder_id,m.direction,m.status,m.read,m.starred,m.snoozed_until`,
	);
	const counts = buildMessageCounts(
		rows.map((row) => ({
			mailboxId: row.mailbox_id,
			folderId: row.folder_id,
			direction: row.direction,
			status: row.status,
			read: !!row.read,
			starred: !!row.starred,
			snoozedUntil:
				row.snoozed_until == null ? null : new Date(row.snoozed_until * 1000),
			total: Number(row.total),
		})),
	);
	const [scheduled] = await withDatabase(
		(sql) => sql.SourceScheduledCount`
 SELECT count(*) AS total FROM messages m WHERE (m.mailbox_id IN(SELECT value FROM json_each(${scope})) OR (${!mailboxId && !mailboxes.length ? 1 : 0}=1 AND m.user_id=${user.id})) AND m.direction='outbound' AND m.status='queued'
 AND EXISTS(SELECT 1 FROM outbound_jobs j WHERE j.message_id=m.id AND j.status='queued' AND j.scheduled_at IS NOT NULL)`,
	);
	counts.folders.scheduled.total = Number(scheduled?.total ?? 0);
	return counts;
}
