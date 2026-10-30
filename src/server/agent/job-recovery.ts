import type { AgentFetch } from "./provider";
import { withDatabase, id, seconds } from "../db";

export async function recoverAgentDraftJobs(
	request: AgentFetch = fetch,
	signal?: AbortSignal,
) {
	const owner = id("agent-dispatch"),
		[lock] = await withDatabase(
			(sql) =>
				sql.NativeClaimAgentDispatcher`INSERT INTO mailrun_job_leases(name,owner,expires_at) VALUES('agent-dispatch',${owner},${seconds() + 600}) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE mailrun_job_leases.expires_at<${seconds()} RETURNING owner`,
		);
	if (!lock) return 0;
	let processed = 0;
	const started = Date.now();
	try {
		const due = await withDatabase(
			(sql) =>
				sql.NativeDueAgentDraftJobs`SELECT id FROM agent_jobs WHERE (status='pending' AND next_attempt_at<=${seconds()}) OR (status='running' AND (lease_until IS NULL OR lease_until<=${seconds()})) ORDER BY created_at,rowid LIMIT 20`,
		);

		for (const job of due) {
			if (signal?.aborted || Date.now() - started >= 240000) break;
			const [renewed] = await withDatabase(
				(sql) =>
					sql.NativeRenewAgentDispatcher`UPDATE mailrun_job_leases SET expires_at=${seconds() + 600} WHERE name='agent-dispatch' AND owner=${owner} RETURNING owner`,
			);
			if (!renewed) break;
			const { processAgentDraftJob } = await import("./jobs");
			if (await processAgentDraftJob(job.id, request, signal)) processed++;
		}
		return processed;
	} finally {
		await withDatabase(
			(sql) =>
				sql.NativeReleaseAgentDispatcher`DELETE FROM mailrun_job_leases WHERE name='agent-dispatch' AND owner=${owner}`,
		);
	}
}
