import type { User } from "../../shared/contracts";
import type { ImportDestination } from "../../lib/import/destination-types";
import {
	getImportMessagePlacement,
	getImportMessageUserId,
} from "../../lib/import/destination";
import { withDatabase, type AppSQL } from "../db";
export async function transferMailbox(
	sql: AppSQL,
	user: User,
	mailboxId: string,
	manage = false,
) {
	const [row] = await sql.NativeTransferMailbox`/* @notNull id */
/* @notNull user_id */
/* @notNull local_part */
SELECT b.id,b.user_id,b.local_part FROM mailboxes b JOIN users u ON u.id=${user.id} AND u.disabled=0 WHERE b.id=${mailboxId} AND b.disabled=0 AND (b.user_id=${user.id} OR (b.type='shared' AND EXISTS(SELECT 1 FROM license_settings WHERE id='default' AND plan='team' AND state='active') AND EXISTS(SELECT 1 FROM mailbox_access WHERE mailbox_id=b.id AND user_id=${user.id} AND (${manage ? 1 : 0}=0 OR permission='full_access'))))`;
	if (!row) throw new Response("Mailbox not found", { status: 404 });
	return row;
}
export async function importContext(
	sql: AppSQL,
	user: User,
	mailboxId: string,
	destination: ImportDestination,
) {
	const box = await transferMailbox(sql, user, mailboxId, true);
	if (destination.type === "folder") {
		const [folder] =
			await sql.NativeImportFolder`SELECT id FROM folders WHERE id=${destination.folderId} AND mailbox_id=${mailboxId}`;
		if (!folder) throw new Response("Folder not found", { status: 404 });
	}
	return {
		userId: getImportMessageUserId(destination, user.id, box.user_id),
		placement: getImportMessagePlacement(destination),
	};
}
export async function validateImport(
	user: User,
	mailboxId: string,
	destination: ImportDestination,
) {
	return withDatabase((sql) =>
		importContext(sql, user, mailboxId, destination),
	);
}
