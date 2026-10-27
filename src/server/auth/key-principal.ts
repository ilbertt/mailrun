import type { User } from "../../shared/contracts";
import type { AppSQL } from "../db";
import type { ApiKeyAuthorization } from "./api-key";
const KEY_PRINCIPAL = Symbol.for("mailrun.api-key-principal");
type KeyGrant = { id: string; userId: string; scope: string };
export type ApiPrincipal = User & { [KEY_PRINCIPAL]: KeyGrant };
type Principal = User & { [KEY_PRINCIPAL]?: KeyGrant };
// Only authenticated server controllers construct this principal. Symbols survive
// in-process service calls and cannot be supplied through a JSON request body.
export function apiKeyPrincipal(
	key: ApiKeyAuthorization,
	scope: string,
): ApiPrincipal {
	return {
		...key.user,
		[KEY_PRINCIPAL]: { id: key.id, userId: key.user.id, scope },
	};
}
export async function assertApiPrincipal(
	sql: AppSQL,
	user: Principal,
	mailboxId?: string,
) {
	const key = user[KEY_PRINCIPAL];
	if (!key) return false;
	if (key.userId !== user.id)
		throw new Response("Unauthorized", { status: 401 });
	const admin = ["domains", "accounts", "mailboxes", "storage"].includes(
		key.scope,
	);
	const [grant] =
		await sql.NativeLiveApiOperation`SELECT k.id FROM api_keys k JOIN users u ON u.id=k.user_id WHERE k.id=${key.id} AND k.user_id=${user.id} AND u.disabled=0 AND (${admin ? 1 : 0}=0 OR u.role='admin') AND json_type(CASE WHEN json_valid(k.scopes) THEN k.scopes ELSE '[]' END)='array' AND (${admin ? 1 : 0}=1 OR NOT EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(k.scopes) THEN k.scopes ELSE '[]' END) WHERE value IN('domains','accounts','mailboxes','storage'))) AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(k.scopes) THEN k.scopes ELSE '[]' END) WHERE value=${key.scope} OR (value='*' AND ${admin ? 1 : 0}=0)) AND (${mailboxId ?? null} IS NULL OR (k.mailbox_scope_enabled=0 AND k.kind!='mcp') OR EXISTS(SELECT 1 FROM mcp_key_mailboxes WHERE key_id=k.id AND mailbox_id=${mailboxId ?? null}))`;
	if (!grant) throw new Response("Unauthorized", { status: 401 });
	return true;
}
export async function adminApiAccess(
	sql: AppSQL,
	user: Principal,
	scope: string,
) {
	const key = user[KEY_PRINCIPAL];
	if (!key) return false;
	if (key.scope !== scope) throw new Response("Unauthorized", { status: 401 });
	return assertApiPrincipal(sql, user);
}
