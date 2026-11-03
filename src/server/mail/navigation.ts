import { withDatabase, seconds } from "../db";
import { mailboxAccess } from "./access";
import { readMailboxScope } from "./read-scope";
import type { User, Folder } from "../../shared/contracts";
import {
	emptyNavigationCounts,
	type FolderCount,
} from "../../shared/navigation";
export async function navigationCounts(user: User, mailboxId: string) {
	await mailboxAccess(user, mailboxId);
	const counts = emptyNavigationCounts();
	const rows = await withDatabase(
		(sql) => sql.NavigationCounts`
 SELECT status,folder_id,starred,read,CASE WHEN snoozed_until>${seconds()} THEN 1 ELSE 0 END AS snoozed,count(*) AS total
 FROM messages WHERE mailbox_id=${mailboxId} AND (status!='draft' OR user_id=${user.id}) GROUP BY status,folder_id,starred,read,snoozed`,
	);
	for (const row of rows) {
		const add = (target: FolderCount) => {
			target.total += Number(row.total);
			if (!row.read) target.unread += Number(row.total);
		};
		const status = row.status;
		if (status === "received") {
			if (row.snoozed) add(counts.folders.snoozed);
			else if (row.folder_id)
				add((counts.customFolders[row.folder_id] ??= { total: 0, unread: 0 }));
			else add(counts.folders.inbox);
		} else if (status === "queued") add(counts.folders.scheduled);
		else if (status === "draft") add(counts.folders.drafts);
		else if (
			status === "sent" ||
			status === "archived" ||
			status === "spam" ||
			status === "trash"
		)
			add(counts.folders[status]);
		if (
			row.starred &&
			status !== "spam" &&
			status !== "trash" &&
			status !== "draft"
		)
			add(counts.folders.starred);
	}
	return counts;
}

export async function moveMessages(
	user: User,
	input: {
		messageIds: string[];
		action: "archive" | "spam" | "trash" | "folder";
		folderId?: string;
	},
) {
	return withDatabase((sql) =>
		sql.begin(async (sql) => {
			let changed = 0;
			for (const messageId of new Set(input.messageIds)) {
				const rows = await sql.MoveNavigationMessage`
  UPDATE messages SET status=${input.action === "archive" ? "archived" : input.action === "spam" ? "spam" : input.action === "trash" ? "trash" : "received"},
  folder_id=${input.action === "folder" ? (input.folderId ?? null) : null},
  trashed_at=CASE WHEN ${input.action}='trash' THEN ${seconds()} ELSE NULL END
  WHERE id=${messageId} AND status NOT IN ('draft','queued') AND mailbox_id IN (
   SELECT b.id FROM mailboxes b JOIN domains d ON d.id=b.domain_id WHERE b.disabled=0 AND
   (b.user_id=${user.id} OR (b.type='shared' AND EXISTS(SELECT 1 FROM license_settings l WHERE l.id='default' AND l.plan='team' AND l.state='active') AND EXISTS (SELECT 1 FROM mailbox_access a WHERE a.mailbox_id=b.id AND a.user_id=${user.id} AND a.permission='full_access')))
   AND (${input.action}!='folder' OR EXISTS (SELECT 1 FROM folders f WHERE f.id=${input.folderId ?? null} AND f.mailbox_id=b.id))
  ) RETURNING id`;
				changed += rows.length;
			}
			if (!changed) throw new Error("No accessible messages to move");
			return { changed };
		}),
	);
}
export async function shortcutSettings(user: User, enabled?: boolean) {
	if (enabled !== undefined)
		await withDatabase(
			(sql) =>
				sql.UpdateKeyboardShortcuts`UPDATE users SET keyboard_shortcuts_enabled=${enabled ? 1 : 0} WHERE id=${user.id}`,
		);
	const [row] = await withDatabase(
		(sql) =>
			sql.KeyboardShortcuts`SELECT keyboard_shortcuts_enabled FROM users WHERE id=${user.id}`,
	);
	return { enabled: !!row?.keyboard_shortcuts_enabled };
}

// Navigation uses each stored message's unread flag, rather than list badges
// (which describe the entire conversation and can include other folders).
export async function sourceMessageNavigation(
	user: User,
	params: URLSearchParams,
) {
	const folder = params.get("folder");
	if (
		!folder ||
		![
			"inbox",
			"starred",
			"snoozed",
			"sent",
			"scheduled",
			"archived",
			"spam",
			"trash",
		].includes(folder)
	)
		throw new Response("Invalid folder", { status: 400 });
	const { ids: scope, fallback } = await readMailboxScope(
		user,
		params.get("mailboxId") || undefined,
	);
	const folderId = params.get("folderId") || null;
	const rows = await withDatabase(
		(sql) => sql.SourceMessageNavigation`
 /* @notNull id */
 SELECT m.id,m.read,m.direction,m.thread_id FROM messages m
 WHERE (m.mailbox_id IN(SELECT value FROM json_each(${scope})) OR (${fallback}=1 AND m.user_id=${user.id}))
 AND (${folderId} IS NULL OR m.folder_id=${folderId})
 AND (
 (${folder}='inbox' AND m.direction='inbound' AND m.status='received' AND (${folderId} IS NOT NULL OR (m.folder_id IS NULL AND (m.snoozed_until IS NULL OR m.snoozed_until<=${seconds()}))))
 OR (${folder}='starred' AND m.starred=1)
 OR (${folder}='snoozed' AND m.status='received' AND m.folder_id IS NULL AND m.snoozed_until>${seconds()})
 OR (${folder}='sent' AND m.direction='outbound' AND m.status='sent')
 OR (${folder}='scheduled' AND m.direction='outbound' AND m.status='queued' AND EXISTS(SELECT 1 FROM outbound_jobs j WHERE j.message_id=m.id AND j.status='queued' AND j.scheduled_at IS NOT NULL))
 OR (${folder} IN('archived','spam','trash') AND m.status=${folder})
 ) ORDER BY m.created_at DESC,m.id DESC`,
	);
	const grouped = params.get("group") === "thread";
	const entries = new Map<string, { id: string; unread: boolean }>();
	for (const row of rows) {
		const key = grouped ? (row.thread_id ?? row.id) : row.id,
			unread = row.direction === "inbound" && !row.read;
		const existing = entries.get(key);
		if (existing) existing.unread ||= unread;
		else entries.set(key, { id: row.id, unread });
	}
	return { messages: [...entries.values()] };
}
