import { z } from "zod";
import type { User } from "../../shared/contracts";
import { withDatabase, seconds, type AppSQL } from "../db";
import { adminWrite } from "../admin/accounts";
import { keyActor } from "../auth/key-management";
const GIB = 1024 ** 3;
const schema = z
	.object({
		outboundAttachmentMaxMb: z.number().int().min(1).max(25).optional(),
		driveStorageLimitGb: z
			.number()
			.positive()
			.max(1_000_000)
			.nullable()
			.optional(),
	})
	.refine(
		(value) =>
			value.outboundAttachmentMaxMb !== undefined ||
			value.driveStorageLimitGb !== undefined,
	);
async function settings(sql: AppSQL) {
	const [row] =
		await sql.NativeGeneralSettings`SELECT outbound_attachment_max_mb,drive_storage_limit_bytes FROM app_settings WHERE id='default'`;
	return {
		outboundAttachmentMaxMb: row?.outbound_attachment_max_mb ?? 25,
		driveStorageLimitGb:
			row?.drive_storage_limit_bytes && row.drive_storage_limit_bytes > 0
				? Math.round((row.drive_storage_limit_bytes / GIB) * 100) / 100
				: null,
	};
}
export async function adminSettingsApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	const url = new URL(request.url),
		path = url.pathname,
		method = request.method;
	if (
		path !== "/api/admin/general" &&
		path !== "/api/activity" &&
		path !== "/api/audit-logs"
	)
		return null;
	if (path === "/api/admin/general") {
		if (method === "GET")
			return Response.json(
				await withDatabase(async (sql) => {
					await keyActor(sql, user, true);
					return settings(sql);
				}),
				{ headers: { "Cache-Control": "no-store" } },
			);
		if (method === "PUT") {
			const input = schema.parse(await request.json());
			return Response.json(
				await adminWrite(async (sql) => {
					await keyActor(sql, user, true);
					await sql.NativeSaveGeneralSettings`INSERT INTO app_settings(id,outbound_attachment_max_mb,drive_storage_limit_bytes,updated_at) VALUES('default',${input.outboundAttachmentMaxMb ?? 25},${input.driveStorageLimitGb == null ? null : Math.round(input.driveStorageLimitGb * GIB)},${seconds()}) ON CONFLICT(id) DO UPDATE SET outbound_attachment_max_mb=CASE WHEN ${input.outboundAttachmentMaxMb === undefined ? 0 : 1}=1 THEN excluded.outbound_attachment_max_mb ELSE app_settings.outbound_attachment_max_mb END,drive_storage_limit_bytes=CASE WHEN ${input.driveStorageLimitGb === undefined ? 0 : 1}=1 THEN excluded.drive_storage_limit_bytes ELSE app_settings.drive_storage_limit_bytes END,updated_at=excluded.updated_at`;
					return settings(sql);
				}),
				{ headers: { "Cache-Control": "no-store" } },
			);
		}
		return null;
	}
	if (method !== "GET") return null;
	const limit = z.coerce
		.number()
		.int()
		.min(0)
		.max(200)
		.parse(Math.min(Number(url.searchParams.get("limit") ?? 100), 200));
	return withDatabase(async (sql) => {
		await keyActor(sql, user, true);
		const rows =
			await sql.NativeAuthActivityList`/* @notNull created_at */ SELECT l.id,l.action,l.metadata,l.created_at,u.email AS actor_email,t.email AS target_email,b.local_part,d.hostname FROM audit_logs l LEFT JOIN users u ON u.id=l.actor_user_id LEFT JOIN users t ON t.id=l.target_user_id LEFT JOIN mailboxes b ON b.id=l.mailbox_id LEFT JOIN domains d ON d.id=b.domain_id WHERE l.action IN('auth.login','auth.logout') ORDER BY l.created_at DESC,l.rowid LIMIT ${limit}`;
		return Response.json(
			path === "/api/activity"
				? {
						activities: rows.map((row) => ({
							id: row.id,
							action: row.action,
							metadata: row.metadata,
							createdAt: new Date(row.created_at * 1000).toISOString(),
							actorEmail: row.actor_email,
						})),
					}
				: {
						auditLogs: rows.map((row) => ({
							id: row.id,
							action: row.action,
							metadata: row.metadata,
							createdAt: new Date(row.created_at * 1000).toISOString(),
							actorEmail: row.actor_email,
							targetEmail: row.target_email,
							mailboxLocalPart: row.local_part,
							mailboxHostname: row.hostname,
						})),
					},
			{ headers: { "Cache-Control": "no-store" } },
		);
	});
}
