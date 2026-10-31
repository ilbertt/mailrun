import bcrypt from "bcryptjs";
import { z } from "zod";
import { withDatabase, seconds } from "../db";
import { userSchema, type User } from "../../shared/contracts";
export type ApiKeyAuthorization = {
	id: string;
	kind: "legacy" | "mcp";
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
		const current = await withDatabase((sql) =>
			sql.begin(async (tx) => {
				const [key] =
					await tx.NativeVerifyLiveApiKey`/* @notNull id */ UPDATE api_keys SET last_used_at=CASE WHEN last_used_at IS NULL OR last_used_at<${seconds() - 60} THEN ${seconds()} ELSE last_used_at END WHERE id=${row.id} AND key_hash=${row.key_hash} AND EXISTS(SELECT 1 FROM users WHERE users.id=api_keys.user_id AND users.disabled=0) RETURNING id,user_id,kind,scopes,mailbox_scope_enabled`;
				if (!key) return null;
				const [user] =
					await tx.NativeLiveApiKeyUser`SELECT id,name,email,role,is_primary_admin FROM users WHERE id=${key.user_id} AND disabled=0`;
				if (!user) return null;
				const restricted = key.mailbox_scope_enabled || key.kind === "mcp",
					allowed = restricted
						? await tx.NativeKeyMailboxScope`SELECT mailbox_id FROM mcp_key_mailboxes WHERE key_id=${key.id}`
						: null;
				return { key, user, allowed };
			}),
		);
		if (!current) return null;
		const { key, user, allowed } = current;

		let scopes: string[] = [];
		try {
			const parsed = z.array(z.string()).safeParse(JSON.parse(key.scopes));
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
			id: key.id,
			kind: key.kind === "mcp" ? "mcp" : "legacy",
			user: userSchema.parse({
				id: user.id,
				name: user.name,
				email: user.email,
				role: user.role,
				isPrimaryAdmin: !!user.is_primary_admin,
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
