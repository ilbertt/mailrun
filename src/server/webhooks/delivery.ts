import { createHmac } from "node:crypto";
import type { User } from "../../shared/contracts";
import { id, seconds, withDatabase } from "../db";
import { adminWrite } from "../admin/accounts";
import { keyActor } from "../auth/key-management";
export type WebhookFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;
export type DeliveryStatus =
	| "pending"
	| "delivered"
	| "failed"
	| "retrying"
	| "exhausted";
export const getRetryDelaySeconds = (attempt: number) =>
	Math.min(60 * 2 ** Math.max(attempt - 1, 0), 3600);
async function responseSnippet(response: Response) {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let result = "",
		bytes = 0;
	try {
		while (bytes < 4096) {
			const next = await reader.read();
			if (next.done) break;
			const chunk = next.value.subarray(0, 4096 - bytes);
			bytes += chunk.length;
			result += decoder.decode(chunk, { stream: true });
		}
		result += decoder.decode();
		return result.trim().slice(0, 500);
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
export async function runWebhookDelivery(
	deliveryId: string,
	options: { user?: User; webhookId?: string; manual?: boolean } = {},
	send: WebhookFetch = fetch,
): Promise<{ status: DeliveryStatus } | null> {
	const owner = id("wh-lease"),
		leaseName = `webhook:${deliveryId}`;
	const claimed = await adminWrite(async (sql) => {
		if (options.user) await keyActor(sql, options.user, true);
		const [row] =
			await sql.NativeWebhookAttemptRecord`SELECT d.id,d.webhook_id,d.event_type,d.payload,d.status,d.attempts,d.next_retry_at,h.user_id,h.url,h.secret,h.max_attempts FROM webhook_deliveries d JOIN webhooks h ON h.id=d.webhook_id WHERE d.id=${deliveryId} AND (${options.webhookId ?? null} IS NULL OR h.id=${options.webhookId ?? null}) AND (${options.user?.id ?? null} IS NULL OR h.user_id=${options.user?.id ?? null})`;
		if (!row) return null;
		if (
			!options.manual &&
			(!["pending", "retrying"].includes(row.status) ||
				(row.next_retry_at != null && row.next_retry_at > seconds()))
		)
			return null;
		const [lease] =
			await sql.NativeClaimWebhookAttempt`INSERT INTO mailrun_job_leases(name,owner,expires_at) VALUES(${leaseName},${owner},${seconds() + 60}) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE mailrun_job_leases.expires_at<${seconds()} RETURNING owner`;
		if (!lease) {
			if (options.manual)
				throw new Response("Delivery is already in progress", { status: 409 });
			return null;
		}
		if (!options.manual && row.attempts >= row.max_attempts) {
			await sql.NativeExhaustWebhookDelivery`UPDATE webhook_deliveries SET status='exhausted',next_retry_at=NULL WHERE id=${deliveryId}`;
			await sql.NativeReleaseUnusedWebhookLease`DELETE FROM mailrun_job_leases WHERE name=${leaseName} AND owner=${owner}`;
			return null;
		}
		const [updated] =
			await sql.NativeStartWebhookAttempt`UPDATE webhook_deliveries SET attempts=attempts+1,status='pending',last_attempt_at=${seconds()},next_retry_at=${seconds() + 60} WHERE id=${deliveryId} RETURNING attempts`;
		if (!updated) throw new Error("Webhook delivery disappeared");
		return { ...row, attempts: updated.attempts };
	});
	if (!claimed) return null;
	const started = Date.now();
	let responseStatus: number | null = null,
		error: string | null = null;
	try {
		try {
			const url = new URL(claimed.url);
			if (
				!["http:", "https:"].includes(url.protocol) ||
				url.username ||
				url.password
			)
				throw new Error(
					"Webhook endpoint must use HTTP or HTTPS without embedded credentials",
				);
			const response = await send(url, {
				method: "POST",
				redirect: "manual",
				signal: AbortSignal.timeout(10_000),
				headers: {
					"Content-Type": "application/json",
					"X-Email-Platform-Signature": createHmac("sha256", claimed.secret)
						.update(claimed.payload)
						.digest("hex"),
					"X-Email-Platform-Event": claimed.event_type,
					"X-Email-Platform-Delivery": deliveryId,
					"X-Email-Platform-Attempt": String(claimed.attempts),
				},
				body: claimed.payload,
			});
			responseStatus = response.status;
			if (!response.ok)
				error =
					(await responseSnippet(response)) ||
					`Endpoint responded with ${response.status}`;
			else await response.body?.cancel().catch(() => {});
		} catch (cause) {
			error =
				cause instanceof Error
					? cause.message || "Request failed"
					: "Request failed";
		}
		const retry = error !== null && claimed.attempts < claimed.max_attempts;
		const status: DeliveryStatus =
			error === null ? "delivered" : retry ? "retrying" : "exhausted";
		const changed = await withDatabase(
			(sql) =>
				sql.NativeFinishWebhookAttempt`UPDATE webhook_deliveries SET status=${status},response_status=${responseStatus},error=${error?.slice(0, 500) ?? null},duration_ms=${Math.max(0, Date.now() - started)},next_retry_at=${retry ? seconds() + getRetryDelaySeconds(claimed.attempts) : null} WHERE id=${deliveryId} AND attempts=${claimed.attempts} AND EXISTS(SELECT 1 FROM mailrun_job_leases WHERE name=${leaseName} AND owner=${owner} AND expires_at>=${seconds()}) RETURNING id`,
		);
		if (!changed.length)
			throw new Response("Webhook delivery changed during the request", {
				status: 409,
			});
		return { status };
	} finally {
		await withDatabase(
			(sql) =>
				sql.NativeReleaseWebhookAttempt`DELETE FROM mailrun_job_leases WHERE name=${leaseName} AND owner=${owner}`,
		);
	}
}
export async function runWebhookJobs(send: WebhookFetch = fetch) {
	const rows = await withDatabase(
		(sql) =>
			sql.NativeDueWebhookDeliveries`SELECT id FROM webhook_deliveries d WHERE status IN('pending','retrying') AND (next_retry_at IS NULL OR next_retry_at<=${seconds()}) AND NOT EXISTS(SELECT 1 FROM mailrun_job_leases WHERE name='webhook:'||d.id AND expires_at>=${seconds()}) ORDER BY coalesce(next_retry_at,created_at),created_at,rowid LIMIT 20`,
	);
	let processed = 0;
	for (let i = 0; i < rows.length; i += 4) {
		await Promise.all(
			rows.slice(i, i + 4).map(async (row) => {
				try {
					if (await runWebhookDelivery(row.id, {}, send)) processed++;
				} catch (error) {
					console.error(`Webhook delivery ${row.id} failed`, error);
				}
			}),
		);
	}
	return processed;
}
