import type { User } from "../../shared/contracts";
import {
	listWebhooks,
	webhookDetails,
	createWebhook,
	updateWebhook,
	deleteWebhook,
	listDeliveries,
	createTestDelivery,
} from "../webhooks/repository";
import { runWebhookDelivery } from "../webhooks/delivery";
import { readLimitedBody } from "../mail/inbound";
export async function webhooksApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	const url = new URL(request.url),
		method = request.method;
	const match =
		/^\/api\/webhooks(?:\/([^/]+)(?:\/(test|deliveries)(?:\/([^/]+)\/retry)?)?)?$/.exec(
			url.pathname,
		);
	if (!match) return null;
	const hookId = match[1] ? decodeURIComponent(match[1]) : undefined,
		section = match[2],
		deliveryId = match[3] ? decodeURIComponent(match[3]) : undefined;
	const json = (value: unknown) =>
		Response.json(value, { headers: { "Cache-Control": "no-store" } });
	const input = async (): Promise<unknown> =>
		JSON.parse(
			new TextDecoder().decode(await readLimitedBody(request, 16 * 1024)),
		);
	if (!hookId) {
		if (method === "GET") return json({ webhooks: await listWebhooks(user) });
		if (method === "POST")
			return json(await createWebhook(user, await input()));
	} else if (!section) {
		if (method === "GET")
			return json({ webhook: await webhookDetails(user, hookId) });
		if (method === "PATCH")
			return json(await updateWebhook(user, hookId, await input()));
		if (method === "DELETE") {
			await deleteWebhook(user, hookId);
			return json({ ok: true });
		}
	} else if (section === "deliveries") {
		if (!deliveryId && method === "GET")
			return json({
				deliveries: await listDeliveries(
					user,
					hookId,
					Number(url.searchParams.get("limit") ?? 25),
					url.searchParams.get("status"),
				),
			});
		if (deliveryId && method === "POST") {
			const result = await runWebhookDelivery(deliveryId, {
				user,
				webhookId: hookId,
				manual: true,
			});
			if (!result) throw new Response("Delivery not found", { status: 404 });
			return json(result);
		}
	} else if (section === "test" && !deliveryId && method === "POST") {
		const id = await createTestDelivery(user, hookId),
			result = await runWebhookDelivery(id, {
				user,
				webhookId: hookId,
				manual: true,
			});
		if (!result) throw new Response("Delivery not found", { status: 404 });
		return json({ deliveryId: id, status: result.status });
	}
	return null;
}
