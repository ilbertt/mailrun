import { jobNameSchema } from "./contract";
export { jobNameSchema } from "./contract";
import type { z } from "zod";
import { withDatabase, seconds, id } from "../db";

export async function runJob(name: z.infer<typeof jobNameSchema>) {
	const owner = id("lease");
	const [lease] = await withDatabase(
		(sql) => sql.ClaimCronLease`
		INSERT INTO mailrun_job_leases (name,owner,expires_at) VALUES (${name},${owner},${seconds() + 600})
		ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
		WHERE mailrun_job_leases.expires_at<${seconds()} RETURNING owner`,
	);
	if (!lease) return { skipped: true };
	try {
		if (name === "scheduled") {
			const jobs = await withDatabase(
				(sql) =>
					sql.DueOutboundJobs`/* @notNull id */ SELECT id FROM outbound_jobs WHERE status='queued' AND EXISTS (SELECT 1 FROM messages WHERE messages.id=outbound_jobs.message_id AND messages.status='queued') AND (scheduled_at IS NULL OR scheduled_at<=${seconds()}) ORDER BY scheduled_at LIMIT 10`,
			);

			for (const job of jobs) {
				const { deliverJob } = await import("../mail/send");
				await deliverJob(job.id).catch((error) =>
					console.error(`Scheduled send ${job.id} failed`, error),
				);
			}
		} else if (name === "maintenance") {
			const { clearSendingStaging } = await import("../mail/sending-staging");
			const { runAvatarJobs } = await import("../avatars/jobs");
			const { runWebhookJobs } = await import("../webhooks/delivery");
			const { runTrashRetention } = await import("./retention");
			await clearSendingStaging();
			await runAvatarJobs();
			await runWebhookJobs();
			const { recoverAgentDraftJobs } = await import("../agent/job-recovery");
			await recoverAgentDraftJobs();
			await runTrashRetention();
			await withDatabase(async (sql) => {
				await sql.ExpireApprovals`UPDATE agent_send_approvals SET status='expired' WHERE status='pending' AND expires_at<${seconds()}`;
				await sql.StalledApprovals`UPDATE agent_send_approvals SET status='unknown' WHERE status='claimed' AND claimed_at<${seconds() - 180}`;
				await sql.PruneAgentConversations`DELETE FROM agent_conversations WHERE updated_at<${seconds() - 30 * 86400}`;
				await sql.PruneSessions`DELETE FROM sessions WHERE expires_at<${seconds()}`;
				await sql.PruneLoginChallenges`DELETE FROM login_challenges WHERE expires_at<${seconds()}`;
			});
		} else {
			const { runDriveRetention } = await import("../drive/retention");
			const { scheduledBackup } = await import("./backup");
			await runDriveRetention();
			await scheduledBackup();
		}
		return { skipped: false };
	} finally {
		await withDatabase(
			(sql) =>
				sql.ReleaseCronLease`DELETE FROM mailrun_job_leases WHERE name=${name} AND owner=${owner}`,
		);
	}
}
