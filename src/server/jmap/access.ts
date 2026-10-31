import { listMailboxes } from "../mail/repository";
import { withDatabase, type AppSQL } from "../db";
import { assertApiPrincipal } from "../auth/key-principal";
import type { JmapContext, AccessibleMailbox } from "./types";
import { JmapError } from "./errors";
export async function listJmapMailboxes(
	ctx: JmapContext,
): Promise<AccessibleMailbox[]> {
	// Event streams outlive authentication. Refresh mailbox grants as well as
	// key/user validity so removing one grant takes effect on the next poll.
	const grants = await withDatabase((sql) =>
		sql.begin(async (sql) => {
			await assertApiPrincipal(sql, ctx.actor);
			return sql.NativeJmapCurrentGrants`SELECT k.mailbox_scope_enabled,k.kind,g.mailbox_id FROM api_keys k LEFT JOIN mcp_key_mailboxes g ON g.key_id=k.id WHERE k.id=${ctx.auth.id} AND k.user_id=${ctx.auth.userId}`;
		}),
	);
	const key = grants[0];
	if (!key) throw new Response("Unauthorized", { status: 401 });
	ctx.auth.mailboxIds =
		!key.mailbox_scope_enabled && key.kind !== "mcp"
			? null
			: grants.flatMap((row) => (row.mailbox_id ? [row.mailbox_id] : []));
	const rows = await listMailboxes(ctx.auth.user);
	return rows
		.filter(
			(row) => !ctx.auth.mailboxIds || ctx.auth.mailboxIds.includes(row.id),
		)
		.map((row) => ({
			id: row.id,
			userId: row.user_id,
			localPart: row.local_part,
			hostname: row.hostname,
			displayName: row.display_name,
			permission: row.permission,
			type: row.type === "shared" ? "shared" : "personal",
			isPrimary:
				`${row.local_part}@${row.hostname}`.toLowerCase() ===
				ctx.auth.email.toLowerCase(),
		}));
}
export async function listAccessibleMailboxIdSet(ctx: JmapContext) {
	return new Set((await listJmapMailboxes(ctx)).map((row) => row.id));
}
export async function listFoldersByMailbox(_ctx: JmapContext, ids: string[]) {
	const result = new Map<string, { id: string; name: string }[]>();
	if (!ids.length) return result;
	const rows = await withDatabase(
		(sql) =>
			sql.NativeJmapFolders`SELECT id,mailbox_id,name FROM folders WHERE mailbox_id IN(SELECT value FROM json_each(${JSON.stringify(ids)})) ORDER BY rowid`,
	);
	for (const row of rows) {
		const items = result.get(row.mailbox_id) ?? [];
		items.push({ id: row.id, name: row.name });
		result.set(row.mailbox_id, items);
	}
	return result;
}
export async function listSendableAddresses(
	ctx: JmapContext,
	box: AccessibleMailbox,
) {
	return (
		(await listMailboxes(ctx.auth.user)).find((row) => row.id === box.id)
			?.senderAddresses ?? []
	);
}
export async function jmapMutation<T>(
	ctx: JmapContext,
	mailboxId: string,
	level: "write" | "manage",
	run: (sql: AppSQL) => Promise<T>,
) {
	return withDatabase((sql) =>
		sql.begin(async (sql) => {
			await sql.NativeJmapWriteFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
			await assertApiPrincipal(sql, ctx.actor, mailboxId);
			const [box] =
				await sql.NativeJmapWriteAccess`SELECT b.id FROM mailboxes b WHERE b.id=${mailboxId} AND b.disabled=0 AND (b.user_id=${ctx.auth.userId} OR (b.type='shared' AND EXISTS(SELECT 1 FROM license_settings WHERE id='default' AND plan='team' AND state='active') AND EXISTS(SELECT 1 FROM mailbox_access WHERE mailbox_id=b.id AND user_id=${ctx.auth.userId} AND (permission='full_access' OR (${level}='write' AND permission IN('send_as','send_on_behalf'))))))`;
			if (!box) throw new JmapError("forbidden");
			return run(sql);
		}),
	);
}
