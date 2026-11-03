import { withDatabase, seconds } from "../db";
import { deleteUnreferencedObjects } from "../storage";

/** Cleanup follows a completed send; a cleanup failure must never retry transport. */
export async function cleanupSubmittedDraft(jobId: string) {
	const [submission] = await withDatabase(
		(sql) => sql.SubmittedDraftCleanupContext`
 /* @notNull draft_id */ /* @notNull draft_revision */ /* @notNull user_id */
 SELECT s.draft_id,s.draft_revision,j.user_id,m.id,m.raw_r2_key,m.status,m.draft_revision AS current_revision,m.user_id AS draft_user_id
 FROM mailrun_submission_drafts s JOIN outbound_jobs j ON j.id=s.job_id
 LEFT JOIN messages m ON m.id=s.draft_id
 WHERE s.job_id=${jobId} AND j.status='sent'
 AND EXISTS(SELECT 1 FROM audit_logs a WHERE a.message_id=j.message_id AND a.action='email.send')`,
	);
	if (!submission) return false;
	try {
		if (
			submission.id &&
			submission.status === "draft" &&
			submission.current_revision === submission.draft_revision &&
			submission.draft_user_id === submission.user_id
		) {
			const files = await withDatabase(
				(sql) =>
					sql.SubmittedDraftCleanupFiles`SELECT r2_key FROM message_attachments WHERE message_id=${submission.draft_id} ORDER BY rowid`,
			);
			// Source removes attachment objects, then MIME, then the draft row. Retain
			// any key referenced by another message or another native storage owner.
			await deleteUnreferencedObjects(
				files.map((file) => file.r2_key),
				submission.draft_id,
			);
			if (submission.raw_r2_key)
				await deleteUnreferencedObjects(
					[submission.raw_r2_key],
					submission.draft_id,
				);
			await withDatabase(
				(sql) =>
					sql.DeleteSubmittedSourceDraft`DELETE FROM messages WHERE id=${submission.draft_id} AND user_id=${submission.user_id} AND status='draft' AND draft_revision=${submission.draft_revision}`,
			);
		}
	} catch (error) {
		console.warn(
			"Submitted draft cleanup failed after completed delivery",
			error,
		);
	}
	await withDatabase(
		(sql) =>
			sql.CompleteSubmittedDraftCleanup`DELETE FROM mailrun_submission_drafts WHERE job_id=${jobId}`,
	);
	return true;
}
export async function recoverSubmittedDrafts() {
	const jobs = await withDatabase(
		(sql) =>
			sql.RecoverSubmittedDraftCleanups`SELECT s.job_id FROM mailrun_submission_drafts s JOIN outbound_jobs j ON j.id=s.job_id WHERE j.status='sent' AND EXISTS(SELECT 1 FROM audit_logs a WHERE a.message_id=j.message_id AND a.action='email.send') ORDER BY j.updated_at LIMIT 10`,
	);
	for (const job of jobs)
		await cleanupSubmittedDraft(job.job_id).catch((error) =>
			console.error("Submitted draft recovery failed", error),
		);
	// A process can disappear after recording provider acknowledgement but before
	// its audit commits. Preserve that draft for review after the active lease
	// expires; never retry transport or hold the draft indefinitely.
	const released = await withDatabase(
		(sql) =>
			sql.ReleaseUnfinishedSubmissionCleanups`DELETE FROM mailrun_submission_drafts WHERE job_id IN(SELECT j.id FROM outbound_jobs j WHERE j.id=mailrun_submission_drafts.job_id AND j.status='sent' AND j.updated_at<${seconds() - 180} AND NOT EXISTS(SELECT 1 FROM audit_logs a WHERE a.message_id=j.message_id AND a.action='email.send') AND NOT EXISTS(SELECT 1 FROM mailrun_job_leases l WHERE l.name='draft:'||mailrun_submission_drafts.draft_id AND l.expires_at>=${seconds()})) RETURNING job_id`,
	);
	return jobs.length + released.length;
}
export async function awaitSubmissionOutcome(jobId: string) {
	const deadline = Date.now() + 120000;
	do {
		const [job] = await withDatabase(
			(sql) =>
				sql.SubmissionDeliveryOutcome`SELECT j.status,j.error,EXISTS(SELECT 1 FROM mailrun_submission_drafts s WHERE s.job_id=j.id) AS cleanup_pending FROM outbound_jobs j WHERE j.id=${jobId}`,
		);
		if (!job) throw new Error("Submitted delivery is unavailable");
		if (job.status === "failed") throw new Error(job.error ?? "Sending failed");
		if (job.status === "sent" && !job.cleanup_pending) return;
		await Bun.sleep(25);
	} while (Date.now() < deadline);
	throw new Error("Delivery outcome needs review");
}
