import { z } from "zod";
import type { User } from "../../shared/contracts";
import { withDatabase, id, seconds } from "../db";
import { hash } from "../auth/service";
import { sessionToken } from "./settings";
import {
	getVapidPublicKey,
	hasValidPushKeys,
	isSupportedPushEndpoint,
} from "../push";
import { readLimitedBody } from "../mail/inbound";
export async function pushApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	const path = new URL(request.url).pathname,
		method = request.method;
	if (path === "/api/push/config" && method === "GET") {
		const publicKey = getVapidPublicKey();
		return Response.json({ enabled: !!publicKey, publicKey });
	}
	if (
		path !== "/api/push/subscriptions" ||
		!["POST", "DELETE"].includes(method)
	)
		return null;
	const input = z
		.object({
			endpoint: z.url().max(4096),
			keys: z
				.object({
					p256dh: z.string().min(1).max(512),
					auth: z.string().min(1).max(256),
				})
				.optional(),
		})
		.parse(
			JSON.parse(
				new TextDecoder().decode(await readLimitedBody(request, 16 * 1024)),
			),
		);
	if (method === "DELETE") {
		await withDatabase(
			(sql) =>
				sql.NativeDeletePush`DELETE FROM push_subscriptions WHERE user_id=${user.id} AND endpoint=${input.endpoint}`,
		);
		return Response.json({ ok: true });
	}
	if (!getVapidPublicKey())
		throw new Response("Push notifications are not configured", {
			status: 503,
		});
	if (
		!input.keys ||
		!isSupportedPushEndpoint(input.endpoint) ||
		!hasValidPushKeys(input.keys)
	)
		throw new Response("Unsupported push subscription", { status: 400 });
	const digest = await hash(sessionToken(request) ?? "");
	const [session] = await withDatabase(
		(sql) =>
			sql.NativePushSession`SELECT id FROM sessions WHERE user_id=${user.id} AND token_hash=${digest} AND expires_at>${seconds()}`,
	);
	if (!session) throw new Response("Unauthorized", { status: 401 });
	await withDatabase(
		(sql) =>
			sql.NativeSavePush`INSERT INTO push_subscriptions (id,user_id,session_id,endpoint,p256dh,auth,created_at,updated_at) VALUES (${id()},${user.id},${session.id},${input.endpoint},${input.keys!.p256dh},${input.keys!.auth},${seconds()},${seconds()}) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,session_id=excluded.session_id,p256dh=excluded.p256dh,auth=excluded.auth,updated_at=excluded.updated_at`,
	);
	return Response.json({ ok: true });
}
