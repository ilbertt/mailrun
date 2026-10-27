import { withDatabase } from "../db";
import type { JmapContext } from "./types";
import { listJmapMailboxes } from "./access";
export async function getEmailState(ctx: JmapContext): Promise<string> {
	const boxes = await listJmapMailboxes(ctx);
	if (!boxes.length) return "[]";
	const rows = await withDatabase(
		(sql) =>
			sql.NativeJmapRevisions`SELECT mailbox_id,revision FROM jmap_mailbox_revisions WHERE mailbox_id IN(SELECT value FROM json_each(${JSON.stringify(boxes.map((box) => box.id))}))`,
	);
	const revisions = new Map(rows.map((row) => [row.mailbox_id, row.revision]));
	return JSON.stringify(
		boxes
			.map((box) => [
				box.id,
				box.permission,
				box.localPart,
				box.hostname,
				box.displayName,
				revisions.get(box.id) ?? 0,
			])
			.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
	);
}
export async function getMailboxState(ctx: JmapContext, state?: string) {
	return state ?? getEmailState(ctx);
}
