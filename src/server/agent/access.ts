import { withDatabase, type AppSQL } from "../db";
import { assertApiPrincipal } from "../auth/key-principal";
import { mailboxAccess } from "../mail/access";
import type { AgentToolContext } from "./types";
import type { CalendarToolContext } from "../../lib/calendar/tool-types";
export async function requireToolAccess(
	ctx: AgentToolContext,
	level: "read" | "send" | "manage" = "read",
) {
	if (ctx.signal?.aborted) throw new Error("Request cancelled");
	await withDatabase(async (sql) => {
		await assertApiPrincipal(sql, ctx.actor ?? ctx.user, ctx.mailboxId);
		const [user] =
			await sql.NativeAgentActiveUser`SELECT id FROM users WHERE id=${ctx.user.id} AND disabled=0`;
		if (!user) throw new Error("Unauthorized");
	});
	return mailboxAccess(ctx.user, ctx.mailboxId, level);
}
export async function withToolUserMutation<T>(
	ctx: CalendarToolContext,
	run: (sql: AppSQL) => Promise<T>,
) {
	return withDatabase((sql) =>
		sql.begin(async (sql) => {
			await sql.NativeAgentUserFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
			if (ctx.signal?.aborted) throw new Error("Request cancelled");
			await assertApiPrincipal(sql, ctx.actor ?? ctx.user);
			const [user] =
				await sql.NativeAgentCurrentUser`SELECT id FROM users WHERE id=${ctx.user.id} AND disabled=0`;
			if (!user) throw new Error("Unauthorized");
			return run(sql);
		}),
	);
}
export async function withToolMutation<T>(
	ctx: AgentToolContext,
	level: "read" | "send" | "manage",
	run: (sql: AppSQL) => Promise<T>,
) {
	return withToolUserMutation(ctx, async (sql) => {
		await assertApiPrincipal(sql, ctx.actor ?? ctx.user, ctx.mailboxId);
		const [box] =
			await sql.NativeAgentMutationAccess`SELECT b.id FROM mailboxes b WHERE b.id=${ctx.mailboxId} AND b.disabled=0 AND (b.user_id=${ctx.user.id} OR (b.type='shared' AND EXISTS(SELECT 1 FROM license_settings WHERE id='default' AND plan='team' AND state='active') AND EXISTS(SELECT 1 FROM mailbox_access a WHERE a.mailbox_id=b.id AND a.user_id=${ctx.user.id} AND (${level}='read' OR a.permission='full_access' OR (${level}='send' AND a.permission IN('send_as','send_on_behalf'))))))`;
		if (!box) throw new Error("Mailbox not found or permission denied");
		return run(sql);
	});
}
