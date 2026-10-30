import { userSchema } from "../../shared/contracts";
import { withDatabase, seconds } from "../db";
import { hash } from "./service";
import { z } from "zod";

/** Read the user, timezone and setup gates from one current SQLite snapshot. */
export async function routeSession(token: string | undefined, bearer?: string) {
	const digest = token && token.length <= 256 ? await hash(token) : null;
	const bearerDigest =
		bearer && bearer.length <= 256 && bearer !== token
			? await hash(bearer)
			: null;
	const [row] = await withDatabase(
		(sql) => sql.NativeRouteSession`
		WITH candidates AS (
		 SELECT u.id,u.email,u.name,u.role,u.is_primary_admin,u.time_zone,'cookie' AS transport,0 AS priority
		 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=${digest} AND s.expires_at>${seconds()} AND u.disabled=0
		 UNION ALL
		 SELECT u.id,u.email,u.name,u.role,u.is_primary_admin,u.time_zone,'bearer' AS transport,1 AS priority
		 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=${bearerDigest} AND s.expires_at>${seconds()} AND u.disabled=0
		), selected AS (SELECT * FROM candidates ORDER BY priority LIMIT 1)
		SELECT u.id,u.email,u.name,u.role,u.is_primary_admin,u.time_zone,u.transport,
		CASE WHEN EXISTS(SELECT 1 FROM users WHERE role='admin') THEN 1 ELSE 0 END AS has_admin,
		CASE WHEN EXISTS(SELECT 1 FROM domains) THEN 1 ELSE 0 END AS has_domain
		FROM (SELECT 1) AS guard
		LEFT JOIN selected u ON 1=1`,
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
		transport: z.enum(["cookie", "bearer"]).nullable().parse(row.transport),
		timeZone: user ? row.time_zone : null,
		needsSetup: row.has_admin !== 1,
		needsOnboarding: user?.role === "admin" && row.has_domain !== 1,
	};
}
