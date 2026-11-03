import { z } from "zod";
import type { User } from "../../shared/contracts";
import { webhookSchema, webhookUpdateSchema } from "../../lib/validators";
import { withDatabase, id, seconds, type AppSQL } from "../db";
import { adminWrite } from "../admin/accounts";
import { keyActor } from "../auth/key-management";
export type WebhookEvent =
	| "message.inbound"
	| "message.outbound"
	| "message.failed";
const validUrl = (value: string) => {
	const url = new URL(value);
	return (
		["http:", "https:"].includes(url.protocol) && !url.username && !url.password
	);
};
const createSchema = webhookSchema.refine((value) => validUrl(value.url), {
	path: ["url"],
	message: "Use an HTTP or HTTPS endpoint without embedded credentials",
});
const updateSchema = webhookUpdateSchema.refine(
	(value) => value.url === undefined || validUrl(value.url),
	{
		path: ["url"],
		message: "Use an HTTP or HTTPS endpoint without embedded credentials",
	},
);
export function parseWebhookEvents(value: string) {
	try {
		return z
			.array(z.unknown())
			.parse(JSON.parse(value))
			.filter((value): value is string => typeof value === "string");
	} catch {
		return [];
	}
}
export async function ownedWebhook(sql: AppSQL, user: User, webhookId: string) {
	await keyActor(sql, user, true);
	const [row] =
		await sql.NativeOwnedWebhook`SELECT * FROM webhooks WHERE id=${webhookId} AND user_id=${user.id}`;
	if (!row) throw new Response("Webhook not found", { status: 404 });
	return row;
}
const iso = (value: number | null) =>
	value === null ? null : new Date(value * 1000).toISOString();
function dto(row: Awaited<ReturnType<typeof ownedWebhook>>) {
	return {
		id: row.id,
		url: row.url,
		description: row.description,
		events: parseWebhookEvents(row.events),
		enabled: !!row.enabled,
		maxAttempts: row.max_attempts,
		createdAt: iso(row.created_at),
	};
}
export async function webhookDetails(user: User, webhookId: string) {
	return withDatabase(async (sql) =>
		dto(await ownedWebhook(sql, user, webhookId)),
	);
}
export async function listWebhooks(user: User) {
	return withDatabase(async (sql) => {
		await keyActor(sql, user, true);
		const rows =
			await sql.NativeWebhookInventory`SELECT * FROM webhooks WHERE user_id=${user.id} ORDER BY created_at DESC,rowid DESC`;
		const stats = await sql.NativeWebhookDeliveryStats`/* @type total number */
/* @type delivered number */
/* @type failing number */
/* @type pending number */
/* @type last_attempt number | null */
SELECT webhook_id,count(*) AS total,CAST(sum(CASE WHEN status='delivered' THEN 1 ELSE 0 END) AS INTEGER) AS delivered,CAST(sum(CASE WHEN status IN('failed','exhausted') THEN 1 ELSE 0 END) AS INTEGER) AS failing,CAST(sum(CASE WHEN status IN('pending','retrying') THEN 1 ELSE 0 END) AS INTEGER) AS pending,CAST(max(last_attempt_at) AS INTEGER) AS last_attempt FROM webhook_deliveries WHERE webhook_id IN(SELECT id FROM webhooks WHERE user_id=${user.id}) GROUP BY webhook_id`;
		return rows.map((row) => {
			const stat = stats.find((stat) => stat.webhook_id === row.id);
			return {
				...dto(row),
				stats: {
					total: stat?.total ?? 0,
					delivered: stat?.delivered ?? 0,
					failing: stat?.failing ?? 0,
					pending: stat?.pending ?? 0,
					lastAttemptAt:
						stat?.last_attempt == null || stat.last_attempt <= 0
							? null
							: stat.last_attempt * 1000,
				},
			};
		});
	});
}
export async function createWebhook(user: User, value: unknown) {
	const input = createSchema.parse(value),
		webhookId = id("wh"),
		secret = id("whsec");
	await adminWrite(async (sql) => {
		await keyActor(sql, user, true);
		await sql.NativeCreateWebhook`INSERT INTO webhooks(id,user_id,url,description,secret,events,enabled,max_attempts,created_at) VALUES(${webhookId},${user.id},${input.url},${input.description?.trim() || null},${secret},${JSON.stringify(input.events)},1,${input.maxAttempts},${seconds()})`;
	});
	return { id: webhookId, url: input.url, secret, events: input.events };
}
export async function updateWebhook(
	user: User,
	webhookId: string,
	value: unknown,
) {
	const input = updateSchema.parse(value),
		secret = input.rotateSecret ? id("whsec") : null;
	if (!Object.keys(input).length)
		throw new Response("No changes provided", { status: 400 });
	await adminWrite(async (sql) => {
		const old = await ownedWebhook(sql, user, webhookId);
		await sql.NativeUpdateWebhook`UPDATE webhooks SET url=${input.url ?? old.url},description=${input.description === undefined ? old.description : input.description?.trim() || null},events=${input.events ? JSON.stringify(input.events) : old.events},enabled=${input.enabled === undefined ? old.enabled : input.enabled ? 1 : 0},max_attempts=${input.maxAttempts ?? old.max_attempts},secret=${secret ?? old.secret} WHERE id=${webhookId} AND user_id=${user.id}`;
	});
	return { ok: true, ...(secret ? { secret } : {}) };
}
export async function deleteWebhook(user: User, webhookId: string) {
	await adminWrite(async (sql) => {
		await ownedWebhook(sql, user, webhookId);
		await sql.NativeDeleteWebhook`DELETE FROM webhooks WHERE id=${webhookId} AND user_id=${user.id}`;
	});
}
export async function listDeliveries(
	user: User,
	webhookId: string,
	limit = 25,
	status?: string | null,
) {
	const bounded =
		Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 100) : 25;
	return withDatabase(async (sql) => {
		const hook = await ownedWebhook(sql, user, webhookId);
		const rows =
			await sql.NativeWebhookDeliveryHistory`SELECT * FROM webhook_deliveries WHERE webhook_id=${webhookId} ORDER BY created_at DESC,rowid DESC LIMIT ${bounded}`;
		return rows
			.filter((row) => !status || row.status === status)
			.map((row) => ({
				id: row.id,
				eventType: row.event_type,
				status: row.status,
				attempts: row.attempts,
				maxAttempts: hook.max_attempts,
				responseStatus: row.response_status,
				error: row.error,
				durationMs: row.duration_ms,
				lastAttemptAt: iso(row.last_attempt_at),
				nextRetryAt: iso(row.next_retry_at),
				createdAt: iso(row.created_at),
				payload: row.payload.slice(0, 2000),
			}));
	});
}
// Called inside the message transaction, so a crash cannot commit mail without its events.
export async function enqueueWebhooks(
	sql: AppSQL,
	userId: string,
	type: WebhookEvent,
	data: Record<string, unknown>,
) {
	const hooks =
		await sql.NativeMatchingWebhooks`SELECT id,events FROM webhooks WHERE user_id=${userId} AND enabled=1 ORDER BY created_at,rowid`;
	const payload = JSON.stringify({ type, data });
	for (const hook of hooks) {
		if (!parseWebhookEvents(hook.events).includes(type)) continue;
		await sql.NativeQueueWebhookEvent`INSERT INTO webhook_deliveries(id,webhook_id,event_type,payload,status,attempts,created_at,next_retry_at) VALUES(${id("whd")},${hook.id},${type},${payload},'pending',0,${seconds()},${seconds()})`;
	}
}
export async function createTestDelivery(user: User, webhookId: string) {
	return adminWrite(async (sql) => {
		await ownedWebhook(sql, user, webhookId);
		const deliveryId = id("whd"),
			payload = JSON.stringify({
				type: "message.inbound",
				test: true,
				data: {
					messageId: "test",
					from: "postmaster@example.com",
					to: "inbox@example.com",
					subject: "Mailflare test delivery",
				},
			});
		await sql.NativeQueueWebhookTest`INSERT INTO webhook_deliveries(id,webhook_id,event_type,payload,status,attempts,created_at,next_retry_at) VALUES(${deliveryId},${webhookId},'message.inbound',${payload},'pending',0,${seconds()},${seconds() + 60})`;
		return deliveryId;
	});
}
