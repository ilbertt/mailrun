import { withDatabase, seconds } from "../db";
import { mailboxAccess } from "./access";
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
   (b.user_id=${user.id} OR d.user_id=${user.id} OR EXISTS (SELECT 1 FROM mailbox_access a WHERE a.mailbox_id=b.id AND a.user_id=${user.id} AND a.permission='full_access'))
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
