import { z } from "zod";
import { withDatabase, id, seconds } from "../db";
import type { User } from "../../shared/contracts";
import { mailboxAccess } from "../mail/access";
import { listMailboxes } from "../mail/repository";
import { addAlias, removeAlias } from "../mail/management";
import { licenseEntitlements } from "../licenses";
import {
	updateMailboxSchema,
	mailboxSchema,
	mailboxAccessSchema,
} from "../../lib/validators";
import { localPartSchema } from "../../shared/mail-contracts";
import { currentProfile } from "./settings";
import { readLimitedBody } from "../mail/inbound";
import { iso } from "../mail/message-query";
export async function mailboxDetail(user: User, mailboxId: string) {
	const access = await mailboxAccess(user, mailboxId);
	const [row] = await withDatabase(
		(sql) =>
			sql.NativeMailboxDetail`SELECT b.*,d.hostname,u.name AS owner_name,u.email AS owner_email,u.avatar_key AS owner_avatar FROM mailboxes b JOIN domains d ON d.id=b.domain_id JOIN users u ON u.id=b.user_id WHERE b.id=${mailboxId}`,
	);
	if (!row) throw new Response("Mailbox not found", { status: 404 });
	const identity =
		row.type === "personal" &&
		`${row.local_part}@${row.hostname}`.toLowerCase() ===
			row.owner_email?.toLowerCase();
	return {
		id: row.id,
		userId: row.user_id,
		domainId: row.domain_id,
		localPart: row.local_part,
		hostname: row.hostname,
		displayName: identity ? row.owner_name : row.display_name,
		hasAvatar: identity ? !!row.owner_avatar : !!row.avatar_key,
		useAllDomains: !!row.use_all_domains,
		signature: row.signature,
		autoReplyEnabled: !!row.auto_reply_enabled,
		autoReplySubject: row.auto_reply_subject,
		autoReplyBody: row.auto_reply_body,
		type: row.type,
		disabled: !!row.disabled,
		permission: access.permission,
		createdAt: iso(row.created_at),
		isPrimary:
			`${row.local_part}@${row.hostname}`.toLowerCase() ===
			user.email.toLowerCase(),
	};
}
export async function mailboxesApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	const url = new URL(request.url),
		path = url.pathname,
		method = request.method,
		json = (value: unknown, status = 200) => Response.json(value, { status });
	const match = /^\/api\/mailboxes\/([^/]+)(?:\/(aliases|access))?$/.exec(path);
	if (path !== "/api/mailboxes" && !match) return null;
	const read = async (): Promise<unknown> =>
		JSON.parse(
			new TextDecoder().decode(await readLimitedBody(request, 64 * 1024)),
		);
	if (!match) {
		if (method === "GET") {
			const rows = await listMailboxes(user);
			return json({
				mailboxes: rows.map((row) => ({
					id: row.id,
					userId: row.user_id,
					domainId: row.domain_id,
					localPart: row.local_part,
					hostname: row.hostname,
					displayName: row.display_name,
					signature: row.signature,
					type: row.type,
					permission: row.permission,
					hasAvatar: !!row.avatar_key,
					autoReplyEnabled: !!row.auto_reply_enabled,
					autoReplySubject: row.auto_reply_subject,
					autoReplyBody: row.auto_reply_body,
					isPrimary:
						`${row.local_part}@${row.hostname}`.toLowerCase() ===
						user.email.toLowerCase(),
					senderAddresses: row.senderAddresses,
				})),
				canCreateShared:
					user.role === "admin" &&
					(await licenseEntitlements()).canShareMailboxes,
			});
		}
		if (method === "POST") {
			const data = mailboxSchema.parse(await read()),
				localPart = localPartSchema.parse(data.localPart),
				type = data.type ?? "personal";
			if (
				type === "shared" &&
				(user.role !== "admin" ||
					!(await licenseEntitlements()).canShareMailboxes)
			)
				throw new Response(
					"A Team license is required to create shared inboxes",
					{ status: 403 },
				);
			const owner = type === "shared" ? user.id : (data.ownerUserId ?? user.id),
				profile = await currentProfile(user);
			if (owner !== user.id) {
				if (user.role !== "admin")
					throw new Response("Forbidden", { status: 403 });
				const [child] = await withDatabase(
					(sql) =>
						sql.NativeMailboxOwner`SELECT id FROM users WHERE id=${owner} AND created_by_user_id=${user.id} AND disabled=0`,
				);
				if (!child) throw new Response("Account not found", { status: 404 });
			}
			const [domain] = await withDatabase(
				(sql) =>
					sql.NativeMailboxDomain`SELECT d.id,d.hostname FROM domains d JOIN users u ON u.id=${user.id} WHERE d.id=${data.domainId} AND (d.user_id=${user.id} OR (${profile.can_manage_mailboxes}=1 AND d.user_id=u.created_by_user_id))`,
			);
			if (!domain) throw new Response("Domain not found", { status: 404 });
			const mailboxId = id("mbx"),
				normalized = localPart.split("+")[0]?.replaceAll(".", "") ?? "";
			const rows = await withDatabase(
				(sql) =>
					sql.NativeCreateMailbox`INSERT INTO mailboxes (id,user_id,domain_id,local_part,display_name,type,created_at) SELECT ${mailboxId},${owner},${data.domainId},${localPart},${data.displayName ?? null},${type},${seconds()} WHERE NOT EXISTS(SELECT 1 FROM mailboxes WHERE domain_id=${domain.id} AND replace(lower(substr(local_part,1,instr(local_part||'+','+')-1)),'.','')=${normalized}) AND NOT EXISTS(SELECT 1 FROM mailbox_aliases WHERE domain_id=${domain.id} AND replace(lower(substr(local_part,1,instr(local_part||'+','+')-1)),'.','')=${normalized}) RETURNING id`,
			);
			if (!rows.length)
				throw new Response("This address is already assigned", { status: 409 });
			// The setup relay forwards the domain to this server; aliases and cross-domain addresses resolve locally.
			return json({
				id: mailboxId,
				address: `${localPart}@${domain.hostname}`,
				type,
			});
		}
		return null;
	}
	const mailboxId = decodeURIComponent(match[1] ?? ""),
		action = match[2];
	if (!action) {
		if (method === "GET")
			return json({ mailbox: await mailboxDetail(user, mailboxId) });
		if (method === "PATCH") {
			const access = await mailboxAccess(user, mailboxId, "manage"),
				input = updateMailboxSchema.parse(await read());
			await withDatabase((sql) =>
				sql.begin(async (tx) => {
					const primary =
						access.type === "personal" &&
						`${access.local_part}@${access.hostname}`.toLowerCase() ===
							access.owner_email?.toLowerCase();
					if (primary && input.displayName !== undefined) {
						const name = input.displayName?.trim();
						if (!name)
							throw new Response("A valid account name is required", {
								status: 400,
							});
						await tx.NativeRenameMailboxOwner`UPDATE users SET name=${name} WHERE id=${access.user_id}`;
					}
					await tx.NativeUpdateMailbox`UPDATE mailboxes SET display_name=CASE WHEN ${input.displayName !== undefined ? 1 : 0}=1 THEN ${input.displayName ?? null} ELSE display_name END,signature=CASE WHEN ${input.signature !== undefined ? 1 : 0}=1 THEN ${input.signature ?? null} ELSE signature END,use_all_domains=COALESCE(${input.useAllDomains === undefined ? null : input.useAllDomains ? 1 : 0},use_all_domains),auto_reply_enabled=COALESCE(${input.autoReplyEnabled === undefined ? null : input.autoReplyEnabled ? 1 : 0},auto_reply_enabled),auto_reply_subject=COALESCE(${input.autoReplySubject ?? null},auto_reply_subject),auto_reply_body=COALESCE(${input.autoReplyBody ?? null},auto_reply_body) WHERE id=${mailboxId}`;
				}),
			);
			return json({ mailbox: await mailboxDetail(user, mailboxId) });
		}
		if (method === "DELETE") {
			const [row] = await withDatabase(
				(sql) =>
					sql.NativeDeleteMailboxOwner`SELECT b.user_id,u.created_by_user_id FROM mailboxes b JOIN users u ON u.id=b.user_id WHERE b.id=${mailboxId}`,
			);
			if (!row) throw new Response("Mailbox not found", { status: 404 });
			const profile = await currentProfile(user);
			if (
				!(
					row.user_id === user.id &&
					(!!profile.can_manage_mailboxes || user.role === "admin")
				) &&
				!(user.role === "admin" && row.created_by_user_id === user.id)
			)
				throw new Response("Forbidden", { status: 403 });
			await withDatabase((sql) =>
				sql.begin(async (tx) => {
					const [sending] =
						await tx.NativeMailboxSending`SELECT j.id FROM outbound_jobs j JOIN messages m ON m.id=j.message_id WHERE m.mailbox_id=${mailboxId} AND j.status='sending' LIMIT 1`;
					if (sending)
						throw new Response("A message is being sent. Try again shortly.", {
							status: 409,
						});
					await tx.NativeCancelMailboxJobs`UPDATE outbound_jobs SET status='cancelled',updated_at=${seconds()} WHERE message_id IN(SELECT id FROM messages WHERE mailbox_id=${mailboxId}) AND status='queued'`;
					await tx.NativeDeleteMailbox`DELETE FROM mailboxes WHERE id=${mailboxId}`;
				}),
			);
			return json({ ok: true });
		}
	}
	if (action === "aliases") {
		const box = await mailboxAccess(user, mailboxId, "manage");
		if (method === "GET") {
			const [aliases, domains] = await withDatabase((sql) =>
				Promise.all([
					sql.NativeMailboxAliases`SELECT a.id,a.domain_id,a.local_part,a.created_at,d.hostname FROM mailbox_aliases a JOIN domains d ON d.id=a.domain_id WHERE a.mailbox_id=${mailboxId} ORDER BY a.created_at,a.id`,
					sql.NativeAliasDomains`SELECT id,hostname FROM domains WHERE user_id=${box.domain_owner} AND status='active' ORDER BY hostname`,
				]),
			);
			return json({
				aliases: aliases.map((a) => ({
					id: a.id,
					domainId: a.domain_id,
					localPart: a.local_part,
					hostname: a.hostname,
					createdAt: iso(a.created_at),
				})),
				availableDomains: domains,
			});
		}
		if (method === "POST") {
			const input = z
				.object({ domainId: z.string(), localPart: localPartSchema })
				.parse(await read());
			return json(await addAlias(user, { ...input, mailboxId }));
		}
		if (method === "DELETE") {
			const aliasId = url.searchParams.get("aliasId");
			if (!aliasId) throw new Response("Alias is required", { status: 400 });
			const [alias] = await withDatabase(
				(sql) =>
					sql.NativeAliasDeleteGuard`SELECT id FROM mailbox_aliases WHERE id=${aliasId} AND mailbox_id=${mailboxId}`,
			);
			if (!alias) throw new Response("Alias not found", { status: 404 });
			await removeAlias(user, aliasId);
			return json({ ok: true });
		}
	}
	if (action === "access") {
		if (
			user.role !== "admin" ||
			!(await licenseEntitlements()).canShareMailboxes
		)
			throw new Response("A Team license is required for mailbox sharing", {
				status: 403,
			});
		const box = await mailboxAccess(user, mailboxId, "manage");
		if (box.user_id !== user.id || box.type !== "shared")
			throw new Response("Shared inbox not found", { status: 404 });
		if (method === "GET") {
			const [members, availableUsers] = await withDatabase((sql) =>
				Promise.all([
					sql.NativeSharedMembers`SELECT a.id,a.user_id,u.email,u.name,a.permission,a.created_at FROM mailbox_access a JOIN users u ON u.id=a.user_id WHERE a.mailbox_id=${mailboxId}`,
					sql.NativeShareUsers`SELECT id,email,name,role FROM users WHERE created_by_user_id=${user.id} AND disabled=0`,
				]),
			);
			return json({
				members: members.map((a) => ({
					id: a.id,
					userId: a.user_id,
					userEmail: a.email,
					userName: a.name,
					permission: a.permission,
					createdAt: iso(a.created_at),
				})),
				availableUsers,
			});
		}
		if (method === "POST") {
			const input = mailboxAccessSchema.parse(await read());
			const [child] = await withDatabase(
				(sql) =>
					sql.NativeShareTarget`SELECT id FROM users WHERE id=${input.userId} AND created_by_user_id=${user.id} AND disabled=0`,
			);
			if (!child) throw new Response("Account not found", { status: 404 });
			await withDatabase(
				(sql) =>
					sql.NativeGrantShare`INSERT INTO mailbox_access (id,mailbox_id,user_id,permission,created_by_user_id,created_at) VALUES (${id("mac")},${mailboxId},${input.userId},${input.permission},${user.id},${seconds()}) ON CONFLICT(mailbox_id,user_id) DO UPDATE SET permission=excluded.permission,created_by_user_id=excluded.created_by_user_id`,
			);
			return json({ ok: true });
		}
		if (method === "DELETE") {
			const userId = url.searchParams.get("userId");
			if (!userId) throw new Response("Account is required", { status: 400 });
			await withDatabase(
				(sql) =>
					sql.NativeRevokeShare`DELETE FROM mailbox_access WHERE mailbox_id=${mailboxId} AND user_id=${userId}`,
			);
			return json({ ok: true });
		}
	}
	return null;
}
