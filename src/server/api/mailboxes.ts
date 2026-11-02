import {
	createMailbox,
	deleteMailbox,
	sharingAdmin,
	sharedMailboxMembers,
	grantMailbox,
	revokeMailbox,
} from "../mail/mailbox-management";
import { syncPersonalIdentity } from "../mail/contacts";
import { z } from "zod";
import { withDatabase, id, seconds, type AppSQL } from "../db";
import type { User } from "../../shared/contracts";
import { mailboxAccess, MailboxAccessError } from "../mail/access";
import { listMailboxMetadata } from "../mail/repository";
import { addAlias, removeAlias } from "../mail/management";
import { licenseEntitlements } from "../licenses";
import {
	updateMailboxSchema,
	mailboxSchema,
	mailboxAccessSchema,
	createMailboxAliasSchema,
} from "../../lib/validators";
import { readLimitedBody } from "../mail/inbound";
import { iso } from "../mail/message-query";
async function sourceMailboxAliases(mailboxId: string) {
	const aliases = await withDatabase(
		(sql) =>
			sql.NativeMailboxAliases`SELECT a.id,a.domain_id,a.local_part,a.created_at,d.hostname FROM mailbox_aliases a JOIN domains d ON d.id=a.domain_id WHERE a.mailbox_id=${mailboxId} ORDER BY a.rowid`,
	);
	return aliases.map((a) => ({
		id: a.id,
		domainId: a.domain_id,
		localPart: a.local_part,
		hostname: a.hostname,
		createdAt: iso(a.created_at),
	}));
}
// The original inbox list repairs accounts lacking any enabled owned personal box.
// The relay already forwards this domain; address resolution stays local here.
export async function ensurePersonalMailbox(user: User) {
	const current = await listMailboxMetadata(user);
	if (current.some((box) => box.user_id === user.id && box.type === "personal"))
		return current;
	const [localPart, hostname] = user.email.toLowerCase().split("@");
	if (!localPart || !hostname) return current;
	try {
		const created = await withDatabase(
			(sql) => sql.NativeEnsurePersonalMailbox`
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,display_name,type,created_at)
 SELECT ${id("mbx")},${user.id},d.id,${localPart},${user.name || localPart},'personal',${seconds()}
 FROM domains d WHERE d.hostname=${hostname}
 AND NOT EXISTS(SELECT 1 FROM mailboxes b WHERE b.user_id=${user.id} AND b.type='personal' AND b.disabled=0)
 AND NOT EXISTS(SELECT 1 FROM mailboxes b WHERE b.domain_id=d.id AND b.local_part=${localPart})
 LIMIT 1 RETURNING id`,
		);
		return created.length ? listMailboxMetadata(user) : current;
	} catch {
		return current;
	}
}
export async function mailboxDetail(
	user: User,
	mailboxId: string,
	context?: AppSQL,
) {
	const read = <T>(run: (sql: AppSQL) => Promise<T>) =>
		context ? run(context) : withDatabase(run);
	const access = await mailboxAccess(user, mailboxId, "read", context);
	const [row] = await read(
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
			const rows = await ensurePersonalMailbox(user);
			const entitlements = await licenseEntitlements();
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
					useAllDomains: !!row.use_all_domains,
					disabled: !!row.disabled,
					createdAt: iso(row.created_at),
					isPrimary: row.isPrimary,
					senderAddresses: row.senderAddresses,
				})),
				canCreateShared:
					user.role === "admin" && entitlements.canShareMailboxes,
			});
		}
		if (method === "POST") {
			const parsed = mailboxSchema.safeParse(await read());
			if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
			return json(await createMailbox(user, parsed.data));
		}
		return null;
	}
	const mailboxId = decodeURIComponent(match[1] ?? ""),
		action = match[2];
	if (!action) {
		if (method === "GET") {
			try {
				return json({ mailbox: await mailboxDetail(user, mailboxId) });
			} catch (error) {
				if (error instanceof MailboxAccessError)
					throw new Response("Mailbox not found", { status: 404 });
				throw error;
			}
		}
		if (method === "PATCH") {
			const parsed = updateMailboxSchema.safeParse(await read());
			if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
			const input = parsed.data;
			try {
				const mailbox = await withDatabase((sql) =>
					sql.begin(async (tx) => {
						await tx.NativeMailboxSettingsFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
						const access = await mailboxAccess(user, mailboxId, "manage", tx);
						const [account] =
							await tx.NativeMailboxSettingsActor`SELECT email FROM users WHERE id=${user.id} AND disabled=0`;
						if (!account) throw new Response("Unauthorized", { status: 401 });
						const primary =
							access.type === "personal" &&
							`${access.local_part}@${access.hostname}`.trim().toLowerCase() ===
								account.email.trim().toLowerCase();
						if (primary && "displayName" in input) {
							const name = input.displayName?.trim();
							if (!name)
								throw new Response("A valid account name is required", {
									status: 400,
								});
							const [owner] =
								await tx.NativeMailboxSettingsOwner`SELECT avatar_key FROM users WHERE id=${access.user_id}`;
							await syncPersonalIdentity(
								access.user_id,
								name,
								owner?.avatar_key ?? null,
								tx,
							);
						}
						const displayName = input.displayName?.trim() || null,
							signature = input.signature?.trim() || null,
							subject = input.autoReplySubject?.trim() || "Out of office",
							body = input.autoReplyBody?.trim() || "";
						await tx.NativeUpdateMailbox`UPDATE mailboxes SET display_name=CASE WHEN ${!primary && "displayName" in input ? 1 : 0}=1 THEN ${displayName} ELSE display_name END,signature=CASE WHEN ${"signature" in input ? 1 : 0}=1 THEN ${signature} ELSE signature END,use_all_domains=COALESCE(${input.useAllDomains === undefined ? null : input.useAllDomains ? 1 : 0},use_all_domains),auto_reply_enabled=COALESCE(${input.autoReplyEnabled === undefined ? null : input.autoReplyEnabled ? 1 : 0},auto_reply_enabled),auto_reply_subject=CASE WHEN ${"autoReplySubject" in input ? 1 : 0}=1 THEN ${subject} ELSE auto_reply_subject END,auto_reply_body=CASE WHEN ${"autoReplyBody" in input ? 1 : 0}=1 THEN ${body} ELSE auto_reply_body END WHERE id=${mailboxId}`;
						return mailboxDetail(user, mailboxId, tx);
					}),
				);
				return json({ mailbox });
			} catch (error) {
				if (error instanceof MailboxAccessError)
					throw new Response("Mailbox not found", { status: 404 });
				throw error;
			}
		}
		if (method === "DELETE") {
			await deleteMailbox(user, mailboxId);
			return json({ ok: true });
		}
	}
	if (action === "aliases") {
		const input =
			method === "POST"
				? createMailboxAliasSchema.safeParse(await read())
				: undefined;
		if (input && !input.success)
			return json({ error: "Enter a valid alias username and domain" }, 400);
		const aliasId = url.searchParams.get("aliasId");
		if (method === "DELETE" && !aliasId)
			return json({ error: "Alias is required" }, 400);
		const box = await mailboxAccess(user, mailboxId, "manage").catch(
			(error) => {
				if (error instanceof MailboxAccessError)
					throw new Response("Mailbox not found", { status: 404 });
				throw error;
			},
		);
		if (method === "GET") {
			const [aliases, domains] = await Promise.all([
				sourceMailboxAliases(mailboxId),
				withDatabase(
					(sql) =>
						sql.NativeAliasDomains`SELECT id,hostname FROM domains WHERE user_id=${box.domain_owner} AND status='active' ORDER BY rowid`,
				),
			]);
			return json({
				aliases,
				availableDomains: domains,
			});
		}
		if (method === "POST" && input?.success) {
			await addAlias(user, { ...input.data, mailboxId });
			return json({ aliases: await sourceMailboxAliases(mailboxId) });
		}
		if (method === "DELETE") {
			if (!aliasId) throw new Response("Alias is required", { status: 400 });
			const [alias] = await withDatabase(
				(sql) =>
					sql.NativeAliasDeleteGuard`SELECT id FROM mailbox_aliases WHERE id=${aliasId} AND mailbox_id=${mailboxId}`,
			);
			if (!alias) throw new Response("Alias not found", { status: 404 });
			await removeAlias(user, aliasId);
			return json({ aliases: await sourceMailboxAliases(mailboxId) });
		}
	}
	if (action === "access") {
		if (method === "GET") {
			const { members, availableUsers } = await sharedMailboxMembers(
				user,
				mailboxId,
			);
			return json({
				members: members.map((row) => ({
					id: row.id,
					userId: row.user_id,
					userEmail: row.email,
					userName: row.name,
					permission: row.permission,
					createdAt: iso(row.created_at),
				})),
				availableUsers,
			});
		}
		await sharingAdmin(user);
		if (method === "POST") {
			const parsed = mailboxAccessSchema.safeParse(await read());
			if (!parsed.success)
				return json({ error: "Choose a valid account" }, 400);
			await grantMailbox(
				user,
				mailboxId,
				parsed.data.userId,
				parsed.data.permission,
			);
			return json({ ok: true });
		}
		if (method === "DELETE") {
			const userId = url.searchParams.get("userId");
			if (!userId) throw new Response("Account is required", { status: 400 });
			await revokeMailbox(user, mailboxId, userId);
			return json({ ok: true });
		}
	}
	return null;
}
