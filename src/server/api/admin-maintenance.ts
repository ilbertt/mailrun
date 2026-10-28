import {
	withDatabase,
	getMigrationStatus,
	applyPendingMigrations,
} from "../db";
import { adminWrite } from "../admin/accounts";
import { publicOrigin } from "../config";
import type { User } from "../../shared/contracts";
import type { AppSQL } from "../db";
import packageMetadata from "../../../package.json";
async function authorize(sql: AppSQL, user: User, primary: boolean) {
	const [actor] =
		await sql.NativeMaintenanceAdmin`SELECT id FROM users WHERE id=${user.id} AND role='admin' AND disabled=0 AND (${primary ? 1 : 0}=0 OR is_primary_admin=1)`;
	if (!actor) throw new Response("Forbidden", { status: 403 });
}
export async function getSearchIndexStatus() {
	return withDatabase(async (sql) => {
		const [row] = await sql.NativeSearchIndexStatus`/* @type indexed number */
/* @type messages number */
SELECT (SELECT count(*) FROM messages_fts) AS indexed,(SELECT count(*) FROM messages) AS messages`;
		return {
			indexed: Number(row?.indexed ?? 0),
			messages: Number(row?.messages ?? 0),
		};
	});
}
export async function adminMaintenanceApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	const path = new URL(request.url).pathname,
		method = request.method;
	if (
		![
			"/api/admin/update",
			"/api/admin/migrations",
			"/api/admin/search-index",
		].includes(path)
	)
		return null;
	await withDatabase((sql) =>
		authorize(sql, user, path !== "/api/admin/search-index"),
	);
	const json = (value: unknown, status = 200) =>
		Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
	if (path === "/api/admin/update") {
		if (method === "GET")
			return json({
				configuration: [],
				configured: false,
				currentVersion: packageMetadata.version,
			});
		if (method === "POST")
			return json(
				{
					error:
						"Self-hosted installs update by redeploying the new Mailrun binary on nibrun.",
				},
				400,
			);
	}
	if (path === "/api/admin/migrations") {
		try {
			if (method === "GET") return json(await getMigrationStatus());
			if (method === "POST") {
				if (request.headers.get("Origin") !== publicOrigin())
					return json({ error: "Invalid request origin" }, 403);
				await withDatabase((sql) => authorize(sql, user, true));
				return json(await applyPendingMigrations());
			}
		} catch (error) {
			return json(
				{
					error:
						error instanceof Error
							? error.message
							: "Could not apply database migrations",
				},
				500,
			);
		}
	}
	if (path === "/api/admin/search-index") {
		if (method === "GET") return json(await getSearchIndexStatus());
		if (method === "POST") {
			await adminWrite(async (sql) => {
				await authorize(sql, user, false);
				await sql.NativeRebuildSearchIndex`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`;
			});
			return json(await getSearchIndexStatus());
		}
	}
	return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
}
