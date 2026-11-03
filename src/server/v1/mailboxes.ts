import { mailboxSchema, updateMailboxSchema } from "../../lib/validators";
import { localPartSchema } from "../../shared/mail-contracts";
import type { ApiPrincipal as User } from "../auth/key-principal";
import { withDatabase, id, seconds, type AppSQL } from "../db";
import { adminWrite } from "../admin/accounts";
import { assertApiPrincipal } from "../auth/key-principal";
import { normalizeLocalPart } from "../mail/routing";
async function managed(sql: AppSQL, user: User, mailboxId: string) {
	await assertApiPrincipal(sql, user);
	const [box] = await sql.NativeV1ManagedMailbox`/* @notNull id */
/* @notNull user_id */
/* @notNull domain_id */
/* @notNull local_part */
/* @notNull type */
/* @notNull disabled */
/* @notNull created_at */
SELECT b.* FROM mailboxes b JOIN users u ON u.id=b.user_id WHERE b.id=${mailboxId} AND (u.id=${user.id} OR u.created_by_user_id=${user.id})`;
	if (!box) throw new Response("Mailbox not found", { status: 404 });
	return box;
}
export async function v1MailboxList(user: User) {
	return withDatabase(async (sql) => {
		await assertApiPrincipal(sql, user);
		const rows = await sql.NativeV1Mailboxes`/* @notNull id */
/* @notNull user_id */
/* @notNull domain_id */
/* @notNull local_part */
/* @notNull hostname */
/* @notNull type */
/* @notNull disabled */
/* @notNull created_at */
SELECT b.id,b.user_id,b.domain_id,b.local_part,d.hostname,b.display_name,b.type,b.disabled,b.created_at FROM mailboxes b JOIN users u ON u.id=b.user_id JOIN domains d ON d.id=b.domain_id WHERE u.id=${user.id} OR u.created_by_user_id=${user.id}`;
		return rows.map((row) => ({
			id: row.id,
			userId: row.user_id,
			domainId: row.domain_id,
			localPart: row.local_part,
			hostname: row.hostname,
			displayName: row.display_name,
			type: row.type,
			disabled: !!row.disabled,
			createdAt: new Date(row.created_at * 1000).toISOString(),
		}));
	});
}
export async function v1MailboxGet(user: User, mailboxId: string) {
	return withDatabase(async (sql) => {
		const b = await managed(sql, user, mailboxId);
		return {
			id: b.id,
			userId: b.user_id,
			domainId: b.domain_id,
			localPart: b.local_part,
			displayName: b.display_name,
			type: b.type,
			disabled: !!b.disabled,
			useAllDomains: !!b.use_all_domains,
			createdAt: new Date(b.created_at * 1000).toISOString(),
		};
	});
}
export async function v1MailboxCreate(user: User, value: unknown) {
	const input = mailboxSchema.parse(value),
		localPart = localPartSchema.parse(input.localPart),
		type = input.type ?? "personal",
		owner = type === "shared" ? user.id : (input.ownerUserId ?? user.id);
	return adminWrite(async (sql) => {
		await assertApiPrincipal(sql, user);
		const [license] =
			await sql.NativeV1MailboxLicense`SELECT plan,state FROM license_settings WHERE id='default'`;
		if (
			type === "shared" &&
			!(license?.plan === "team" && license.state === "active")
		)
			throw new Response(
				"A Team license is required to create shared inboxes",
				{ status: 403 },
			);
		if (owner !== user.id) {
			const [child] =
				await sql.NativeV1MailboxChild`SELECT id FROM users WHERE id=${owner} AND created_by_user_id=${user.id}`;
			if (!child) throw new Response("Account not found", { status: 404 });
		}
		const [domain] =
			await sql.NativeV1MailboxDomain`SELECT id,hostname FROM domains WHERE id=${input.domainId} AND user_id=${user.id}`;
		if (!domain) throw new Response("Domain not found", { status: 404 });
		const normalized = normalizeLocalPart(localPart),
			[occupied] =
				await sql.NativeV1MailboxOccupied`SELECT id FROM mailboxes WHERE domain_id=${domain.id} AND replace(lower(substr(local_part,1,instr(local_part||'+','+')-1)),'.','')=${normalized} UNION ALL SELECT id FROM mailbox_aliases WHERE domain_id=${domain.id} AND replace(lower(substr(local_part,1,instr(local_part||'+','+')-1)),'.','')=${normalized} LIMIT 1`;
		if (occupied)
			throw new Response("This address is already assigned", { status: 409 });
		const mailboxId = id("mbx");
		await sql.NativeV1CreateMailbox`INSERT INTO mailboxes(id,user_id,domain_id,local_part,display_name,type,created_at) VALUES(${mailboxId},${owner},${domain.id},${localPart},${input.displayName ?? null},${type},${seconds()})`;
		// The domain relay already routes these addresses through local resolution.
		return { id: mailboxId, address: `${localPart}@${domain.hostname}`, type };
	});
}
export async function v1MailboxUpdate(
	user: User,
	mailboxId: string,
	value: unknown,
) {
	const input = updateMailboxSchema.parse(value);
	await adminWrite(async (sql) => {
		const old = await managed(sql, user, mailboxId);
		await sql.NativeV1UpdateMailbox`UPDATE mailboxes SET display_name=${input.displayName === undefined ? old.display_name : input.displayName?.trim() || null},signature=${input.signature === undefined ? old.signature : input.signature?.trim() || null},use_all_domains=${input.useAllDomains === undefined ? old.use_all_domains : input.useAllDomains ? 1 : 0},auto_reply_enabled=${input.autoReplyEnabled === undefined ? old.auto_reply_enabled : input.autoReplyEnabled ? 1 : 0},auto_reply_subject=${input.autoReplySubject === undefined ? old.auto_reply_subject : input.autoReplySubject?.trim() || "Out of office"},auto_reply_body=${input.autoReplyBody === undefined ? old.auto_reply_body : input.autoReplyBody?.trim() || ""} WHERE id=${mailboxId}`;
	});
	return { ok: true };
}
export async function v1MailboxDelete(user: User, mailboxId: string) {
	await adminWrite(async (sql) => {
		await managed(sql, user, mailboxId);
		const [sending] =
			await sql.NativeV1MailboxSending`SELECT j.id FROM outbound_jobs j JOIN messages m ON m.id=j.message_id WHERE m.mailbox_id=${mailboxId} AND j.status='sending' LIMIT 1`;
		if (sending)
			throw new Response("A message is being sent. Try again shortly.", {
				status: 409,
			});
		await sql.NativeV1CancelMailboxJobs`UPDATE outbound_jobs SET status='cancelled',updated_at=${seconds()} WHERE status='queued' AND message_id IN(SELECT id FROM messages WHERE mailbox_id=${mailboxId})`;
		await sql.NativeV1DeleteMailbox`DELETE FROM mailboxes WHERE id=${mailboxId}`;
	});
	return { ok: true };
}
