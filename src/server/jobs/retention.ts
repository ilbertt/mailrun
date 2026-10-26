import { withDatabase, seconds } from "../db";
import { permanentlyDeleteMessages } from "../mail/message-actions";
import { userSchema } from "../../shared/contracts";
import {
	normalizeTrashRetentionDays,
	TRASH_RETENTION_BATCH_SIZE,
} from "../../lib/email/trash-retention-utils";
export async function runTrashRetention(now = seconds()) {
	const owners = await withDatabase(
		(sql) =>
			sql.NativeRetentionOwners`SELECT id,email,name,role,is_primary_admin,trash_retention_days FROM users WHERE trash_retention_days IS NOT NULL ORDER BY id`,
	);
	let budget = TRASH_RETENTION_BATCH_SIZE,
		deleted = 0;
	for (const owner of owners) {
		const days = normalizeTrashRetentionDays(owner.trash_retention_days);
		if (!days || budget <= 0) continue;
		const cutoff = now - days * 86400;
		const rows = await withDatabase(
			(sql) =>
				sql.NativeExpiredMail`SELECT id,mailbox_id,status FROM messages WHERE user_id=${owner.id} AND status IN ('trash','spam') AND trashed_at<${cutoff} ORDER BY trashed_at,id LIMIT ${budget}`,
		);
		if (!rows.length) continue;
		const user = userSchema.parse({
			...owner,
			isPrimaryAdmin: !!owner.is_primary_admin,
		});
		const result = await permanentlyDeleteMessages(
			user,
			rows,
			"retention",
			cutoff,
		);
		deleted += result.deleted;
		budget -= rows.length;
	}
	return deleted;
}
