import { z } from "zod";
import bcrypt from "bcryptjs";
import { withDatabase, id, seconds, type AppSQL } from "../db";
import { adminWrite } from "../admin/accounts";
import type { User } from "../../shared/contracts";
import { API_KEY_SCOPES, ADMIN_API_KEY_SCOPES } from "../../lib/api/scopes";
export const MCP_KEY_SCOPES = [
	"mcp:read",
	"mcp:draft",
	"mcp:organize",
	"mcp:request-send",
	"mcp:calendar-read",
	"mcp:calendar-write",
] as const;
export const personalKeySchema = z.object({
	name: z.string().trim().min(1).max(100),
	scopes: z.array(z.enum(API_KEY_SCOPES)).min(1),
	mailboxIds: z.array(z.string().min(1)).max(30),
});
export const mcpKeySchema = personalKeySchema.extend({
	scopes: z.array(z.enum(MCP_KEY_SCOPES)).min(1),
});
export const adminKeySchema = z.object({
	name: z.string().trim().min(1).max(100),
	scopes: z.array(z.enum(ADMIN_API_KEY_SCOPES)).min(1),
	mcpAllowed: z.boolean().default(false),
});
export const parseKeyScopes = (value: string) => {
	try {
		const parsed = z.array(z.unknown()).parse(JSON.parse(value));
		return parsed.filter((value): value is string => typeof value === "string");
	} catch {
		return [];
	}
};
export const isAdminKey = (scopes: string[]) =>
	scopes.some((scope) =>
		(ADMIN_API_KEY_SCOPES as readonly string[]).includes(scope),
	);
export async function keyActor(sql: AppSQL, user: User, primary = false) {
	const [actor] =
		await sql.NativeKeyManagerActor`SELECT id,role,is_primary_admin FROM users WHERE id=${user.id} AND disabled=0`;
	if (!actor) throw new Response("Unauthorized", { status: 401 });
	if (primary && !(actor.role === "admin" && actor.is_primary_admin))
		throw new Response("Forbidden", { status: 403 });
	return actor;
}
async function readableMailbox(sql: AppSQL, user: User, mailboxId: string) {
	const [row] =
		await sql.NativeKeyMailboxPermission`SELECT b.id FROM mailboxes b WHERE b.id=${mailboxId} AND b.disabled=0 AND (b.user_id=${user.id} OR (b.type='shared' AND EXISTS(SELECT 1 FROM license_settings WHERE id='default' AND plan='team' AND state='active') AND EXISTS(SELECT 1 FROM mailbox_access WHERE mailbox_id=b.id AND user_id=${user.id})))`;
	return !!row;
}
export async function listManagedKeys(
	user: User,
	kind: "personal" | "mcp" | "admin",
) {
	return withDatabase(async (sql) => {
		await keyActor(sql, user, kind === "admin");
		const rows =
				await sql.NativeListManagedKeys`SELECT id,name,prefix,kind,scopes,mailbox_scope_enabled,created_at,last_used_at FROM api_keys WHERE user_id=${user.id} ORDER BY rowid`,
			keys = rows.filter((row) =>
				kind === "admin"
					? isAdminKey(parseKeyScopes(row.scopes))
					: !isAdminKey(parseKeyScopes(row.scopes)) &&
						(kind !== "mcp" || row.kind === "mcp"),
			);
		const allowed = keys.length
			? await sql.NativeManagedKeyMailboxes`SELECT key_id,mailbox_id FROM mcp_key_mailboxes WHERE key_id IN(SELECT value FROM json_each(${JSON.stringify(keys.map((key) => key.id))}))`
			: [];
		return keys.map((row) => ({
			id: row.id,
			name: row.name,
			prefix: row.prefix,
			kind: row.kind,
			scopes:
				kind === "admin"
					? JSON.stringify(
							parseKeyScopes(row.scopes).filter((scope) =>
								(ADMIN_API_KEY_SCOPES as readonly string[]).includes(scope),
							),
						)
					: row.scopes,
			mailboxScopeEnabled: !!row.mailbox_scope_enabled,
			mailboxIds: allowed
				.filter((entry) => entry.key_id === row.id)
				.map((entry) => entry.mailbox_id),
			createdAt: new Date(row.created_at * 1000).toISOString(),
			lastUsedAt:
				row.last_used_at === null
					? null
					: new Date(row.last_used_at * 1000).toISOString(),
		}));
	});
}
export async function createManagedKey(
	user: User,
	kind: "personal" | "mcp" | "admin",
	value: unknown,
) {
	const input =
			kind === "admin"
				? adminKeySchema.parse(value)
				: kind === "mcp"
					? mcpKeySchema.parse(value)
					: personalKeySchema.parse(value),
		mailboxIds = "mailboxIds" in input ? [...new Set(input.mailboxIds)] : [],
		scopes = [...new Set(input.scopes)];
	if (
		kind !== "admin" &&
		!mailboxIds.length &&
		scopes.some(
			(scope) =>
				!(kind === "mcp"
					? scope.startsWith("mcp:calendar-")
					: scope.startsWith("calendar:")),
		)
	)
		throw new Response("Choose a mailbox for mail permissions", {
			status: 400,
		});
	await withDatabase((sql) => keyActor(sql, user, kind === "admin"));
	const alphabet =
			"_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
		key =
			"ep_" +
			[...crypto.getRandomValues(new Uint8Array(21))]
				.map((byte) => alphabet.charAt(byte & 63))
				.join(""),
		hash = await bcrypt.hash(key, 10),
		prefix = key.slice(0, 12),
		keyId = id("key");
	await adminWrite(async (sql) => {
		await keyActor(sql, user, kind === "admin");
		for (const mailboxId of mailboxIds)
			if (!(await readableMailbox(sql, user, mailboxId)))
				throw new Response("Mailbox not found", { status: 403 });
		await sql.NativeCreateManagedKey`INSERT INTO api_keys(id,user_id,name,prefix,key_hash,scopes,kind,mailbox_scope_enabled,created_at) VALUES(${keyId},${user.id},${input.name},${prefix},${hash},${JSON.stringify(scopes)},${kind === "mcp" || ("mcpAllowed" in input && input.mcpAllowed) ? "mcp" : "legacy"},${kind === "admin" ? 0 : 1},${seconds()})`;
		for (const mailboxId of mailboxIds)
			await sql.NativeGrantManagedKeyMailbox`INSERT INTO mcp_key_mailboxes(key_id,mailbox_id) VALUES(${keyId},${mailboxId})`;
	});
	return { id: keyId, name: input.name, prefix, key, mailboxIds, scopes };
}
export async function revokeManagedKey(
	user: User,
	kind: "personal" | "mcp" | "admin",
	keyId: string,
) {
	return adminWrite(async (sql) => {
		await keyActor(sql, user, kind === "admin");
		const [key] =
			await sql.NativeOwnedManagedKey`SELECT id,kind,scopes FROM api_keys WHERE id=${keyId} AND user_id=${user.id}`;
		if (
			!key ||
			(kind === "mcp" && key.kind !== "mcp") ||
			(kind === "admin" && !isAdminKey(parseKeyScopes(key.scopes)))
		)
			throw new Response("Key not found", { status: 404 });
		if (kind === "personal" && isAdminKey(parseKeyScopes(key.scopes)))
			throw new Response("Manage this key in Admin API keys", { status: 403 });
		await sql.NativeCancelRevokedKeyApprovals`UPDATE agent_send_approvals SET status='cancelled' WHERE request_key_id=${key.id} AND status='pending'`;
		await sql.NativeRevokeManagedKey`DELETE FROM api_keys WHERE id=${key.id} AND user_id=${user.id}`;
		return { ok: true };
	});
}
