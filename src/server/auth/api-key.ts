import bcrypt from "bcryptjs";
import { z } from "zod";
import { withDatabase, seconds } from "../db";
import { userSchema, type User } from "../../shared/contracts";
export type ApiKeyAuthorization = {
	id: string;
	user: User;
	scopes: string[];
	mailboxIds: string[] | null;
};
export async function authenticateApiKey(
	request: Request,
): Promise<ApiKeyAuthorization | null> {
	const authorization = request.headers.get("authorization") ?? "";
	let value = "";
	if (authorization.startsWith("Bearer "))
		value = authorization.slice(7).trim();
	else if (authorization.startsWith("Basic ")) {
		try {
			const decoded = atob(authorization.slice(6).trim());
			value = decoded.slice(decoded.indexOf(":") + 1).trim();
		} catch {
			return null;
		}
	}
	if (!value.startsWith("ep_") || value.length > 256) return null;
	const candidates = await withDatabase(
		(sql) =>
			sql.NativeApiKeyCandidates`/* @notNull id */ SELECT k.id,k.key_hash,k.scopes,k.mailbox_scope_enabled,u.id AS user_id,u.name,u.email,u.role,u.is_primary_admin FROM api_keys k JOIN users u ON u.id=k.user_id WHERE k.prefix=${value.slice(0, 12)} AND u.disabled=0`,
	);
	for (const row of candidates) {
		if (!(await bcrypt.compare(value, row.key_hash))) continue;
		const allowed = row.mailbox_scope_enabled
			? await withDatabase(
					(sql) =>
						sql.NativeKeyMailboxScope`SELECT mailbox_id FROM mcp_key_mailboxes WHERE key_id=${row.id}`,
				)
			: null;
		await withDatabase(
			(sql) =>
				sql.NativeTouchApiKey`UPDATE api_keys SET last_used_at=${seconds()} WHERE id=${row.id} AND (last_used_at IS NULL OR last_used_at<${seconds() - 60})`,
		);
		let scopes: string[] = [];
		try {
			const parsed = z.array(z.string()).safeParse(JSON.parse(row.scopes));
			if (parsed.success) scopes = parsed.data;
		} catch {}
		const adminScopes = new Set([
			"domains",
			"accounts",
			"mailboxes",
			"storage",
		]);
		const administrative = scopes.some((scope) => adminScopes.has(scope));
		return {
			id: row.id,
			user: userSchema.parse({
				id: row.user_id,
				name: row.name,
				email: row.email,
				role: row.role,
				isPrimaryAdmin: !!row.is_primary_admin,
			}),
			scopes: administrative
				? scopes.filter((scope) => adminScopes.has(scope))
				: scopes,
			mailboxIds: allowed?.map((value) => value.mailbox_id) ?? null,
		};
	}
	return null;
}
export const hasScope = (key: ApiKeyAuthorization, scope: string) =>
	key.scopes.includes(scope) || key.scopes.includes("*");
