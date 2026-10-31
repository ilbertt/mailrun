import { authenticateApiKey } from "../auth/api-key";
import { apiKeyPrincipal, assertApiPrincipal } from "../auth/key-principal";
import { withDatabase } from "../db";
import { listMailboxes } from "../mail/repository";
import { z } from "zod";
export const MCP_SCOPES = new Set([
	"mcp:read",
	"mcp:draft",
	"mcp:organize",
	"mcp:request-send",
	"mcp:calendar-read",
	"mcp:calendar-write",
]);
const ADMIN_SCOPES = new Set(["domains", "accounts", "mailboxes", "storage"]);
export async function authenticateMcpRequest(request: Request) {
	if (!request.headers.get("authorization")?.startsWith("Bearer ")) return null;
	const key = await authenticateApiKey(request);
	if (!key || key.kind !== "mcp") return null;
	const [row] = await withDatabase(
		(sql) =>
			sql.NativeMcpCurrentKey`SELECT k.scopes,k.kind,u.time_zone FROM api_keys k JOIN users u ON u.id=k.user_id WHERE k.id=${key.id} AND k.user_id=${key.user.id} AND u.disabled=0`,
	);
	if (!row || row.kind !== "mcp") return null;
	let scopes: string[];
	try {
		scopes = z.array(z.string()).parse(JSON.parse(row.scopes));
	} catch {
		return null;
	}
	const mail =
			scopes.length > 0 && scopes.every((scope) => MCP_SCOPES.has(scope)),
		admin =
			scopes.length > 0 && scopes.every((scope) => ADMIN_SCOPES.has(scope));
	if ((!mail && !admin) || (admin && key.user.role !== "admin")) return null;
	// Validate original scopes, before the shared v1 authenticator sanitizes mixed keys.
	key.scopes = scopes;
	const mailboxIds = mail
		? (await listMailboxes(key.user))
				.filter((box) => key.mailboxIds?.includes(box.id))
				.map((box) => box.id)
		: [];
	return {
		key,
		keyId: key.id,
		user: key.user,
		scopes,
		mailboxIds,
		timeZone: row.time_zone ?? "UTC",
	};
}
export type McpPrincipal = NonNullable<
	Awaited<ReturnType<typeof authenticateMcpRequest>>
>;
export async function requireMcpScope(
	principal: McpPrincipal,
	scope: string,
	mailboxId?: string,
) {
	if (
		!principal.scopes.includes(scope) ||
		(mailboxId !== undefined && !principal.mailboxIds.includes(mailboxId))
	)
		throw new Error("Permission denied");
	const actor = apiKeyPrincipal(principal.key, scope);
	await withDatabase((sql) => assertApiPrincipal(sql, actor, mailboxId));
	return actor;
}
