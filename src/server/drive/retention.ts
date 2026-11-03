import { seconds } from "../db";
import { driveWrite, driveRow } from "./repository";
import { cleanDeletedDrive, removeDriveRows } from "./mutations";
import { deleteUnreferencedObjects } from "../storage";
import { DRIVE_UPLOAD_RESUME_MS } from "../../lib/drive/utils";
export async function cleanupStaleDriveUploads(maxPasses = 20) {
	let count = 0;
	for (let pass = 0; pass < maxPasses; pass++) {
		const removed = await driveWrite(async (sql) => {
			const rows =
				await sql.NativeStaleDriveUploads`SELECT * FROM drive_items WHERE upload_id IS NOT NULL AND (updated_at<${seconds() - DRIVE_UPLOAD_RESUME_MS / 1000} OR upload_id NOT LIKE 'local_%') AND NOT EXISTS(SELECT 1 FROM mailrun_job_leases WHERE name='drive:'||drive_items.id AND expires_at>=${seconds()}) LIMIT 100`;
			return removeDriveRows(sql, rows.map(driveRow));
		});
		await cleanDeletedDrive(removed);
		count += removed.length;
		if (removed.length < 100) break;
	}
	return count;
}
export async function runDriveRetention() {
	let count = 0;
	for (let pass = 0; pass < 20; pass++) {
		const result = await driveWrite(async (sql) => {
			const rows =
					await sql.NativeExpiredDriveTrash`SELECT * FROM drive_items WHERE trashed_at<${seconds() - 30 * 86400} LIMIT 100`,
				attachments =
					await sql.NativeExpiredDriveAttachmentTrash`SELECT id,r2_key FROM message_attachments WHERE trashed_at<${seconds() - 30 * 86400} LIMIT 100`;
			const removed = await removeDriveRows(sql, rows.map(driveRow));
			await sql.NativePurgeDriveAttachmentTrash`DELETE FROM message_attachments WHERE id IN(SELECT value FROM json_each(${JSON.stringify(attachments.map((row) => row.id))}))`;
			return { removed, attachments, roots: rows.length };
		});
		await cleanDeletedDrive(result.removed);
		await deleteUnreferencedObjects(
			result.attachments.map((row) => row.r2_key),
		);
		count += result.removed.length + result.attachments.length;
		if (result.roots < 100 && result.attachments.length < 100) break;
	}
	return { purged: count, aborted: await cleanupStaleDriveUploads() };
}
