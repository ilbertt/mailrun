import type { User } from "../../shared/contracts";
import { withDatabase } from "../db";
import { iso } from "../mail/message-query";
export async function adminReadApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	const url = new URL(request.url),
		path = url.pathname;
	if (request.method !== "GET") return null;
	if (path === "/api/domains") {
		const [profile] = await withDatabase(
			(sql) =>
				sql.NativeDomainListActor`SELECT created_by_user_id,can_manage_mailboxes FROM users WHERE id=${user.id}`,
		);
		const owner =
			profile?.can_manage_mailboxes && profile.created_by_user_id
				? profile.created_by_user_id
				: user.id;
		const rows = await withDatabase(
			(sql) =>
				sql.NativeListDomains`SELECT * FROM domains WHERE user_id=${owner} ORDER BY created_at,id`,
		);
		return Response.json({
			domains: rows.map((row) => ({
				id: row.id,
				userId: row.user_id,
				hostname: row.hostname,
				zoneId: row.zone_id,
				status: row.status,
				routingStatus: row.routing_status,
				sendingEnabled: !!row.sending_enabled,
				routingEnabled: !!row.routing_enabled,
				sendingRequested: !!row.sending_requested,
				sendingSubdomainTag: row.sending_subdomain_tag,
				sendingProvider: row.sending_provider,
				receivingProvider: row.receiving_provider,
				createdAt: iso(row.created_at),
			})),
		});
	}

	return null;
}
