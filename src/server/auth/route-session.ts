import { userSchema } from "../../shared/contracts";
import { withDatabase, seconds } from "../db";
import { hash } from "./service";

/** Read the user, timezone and setup gates from one current SQLite snapshot. */
export async function routeSession(token: string | undefined) {
	const digest = token && token.length <= 256 ? await hash(token) : null;
	const [row] = await withDatabase(
		(sql) => sql.NativeRouteSession`
		SELECT u.id,u.email,u.name,u.role,u.is_primary_admin,u.time_zone,
		CASE WHEN EXISTS(SELECT 1 FROM users WHERE role='admin') THEN 1 ELSE 0 END AS has_admin,
		CASE WHEN EXISTS(SELECT 1 FROM domains) THEN 1 ELSE 0 END AS has_domain
		FROM (SELECT 1) AS guard
		LEFT JOIN sessions s ON s.token_hash=${digest} AND s.expires_at>${seconds()}
		LEFT JOIN users u ON u.id=s.user_id AND u.disabled=0 LIMIT 1`,
	);
	if (!row) throw new Error("Missing session snapshot");
	const user =
		row.id === null
			? null
			: userSchema.parse({
					id: row.id,
					email: row.email,
					name: row.name,
					role: row.role,
					isPrimaryAdmin: row.is_primary_admin === 1,
				});
	return {
		user,
		timeZone: user ? row.time_zone : null,
		needsSetup: row.has_admin !== 1,
		needsOnboarding: user?.role === "admin" && row.has_domain !== 1,
	};
}
