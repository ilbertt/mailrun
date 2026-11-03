import type { z } from "zod";
import type { User } from "../../shared/contracts";
import type { mailboxSchema, mailboxAccessSchema } from "../../lib/validators";
import { withDatabase, id, seconds, type AppSQL } from "../db";
import { licenseEntitlements } from "../licenses";
async function liveActor(sql: AppSQL, user: User) {
	const [actor] =
		await sql.MailboxManagementActor`SELECT id,role,is_primary_admin,can_manage_mailboxes,created_by_user_id FROM users WHERE id=${user.id} AND disabled=0`;
	if (!actor) throw new Response("Unauthorized", { status: 401 });
	return actor;
}
export async function createMailbox(
	user: User,
	input: z.output<typeof mailboxSchema>,
) {
	const type = input.type ?? "personal";
	if (type === "shared") await licenseEntitlements();
	return withDatabase((sql) =>
		sql.begin(async (tx) => {
			await tx.CreateMailboxFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
			const actor = await liveActor(tx, user);
			if (type === "shared") {
				const [license] =
					await tx.CreateSharedMailboxLicense`SELECT plan,state FROM license_settings WHERE id='default'`;
				if (
					actor.role !== "admin" ||
					license?.plan !== "team" ||
					license.state !== "active"
				)
					throw new Response(
						"A Team license is required to create shared inboxes",
						{ status: 403 },
					);
			}
			const ownerId =
				type === "shared" ? actor.id : (input.ownerUserId ?? actor.id);
			if (ownerId !== actor.id) {
				if (actor.role !== "admin")
					throw new Response("Forbidden", { status: 403 });
				const [owner] =
					await tx.CreateMailboxChild`SELECT id FROM users WHERE id=${ownerId} AND created_by_user_id=${actor.id}`;
				if (!owner) throw new Response("Account not found", { status: 404 });
			}
			const [domain] =
				await tx.CreateMailboxDomain`SELECT id,user_id,hostname FROM domains WHERE id=${input.domainId}`;
			if (
				!domain ||
				!(
					domain.user_id === actor.id ||
					((actor.is_primary_admin || actor.can_manage_mailboxes) &&
						!!actor.created_by_user_id &&
						domain.user_id === actor.created_by_user_id)
				)
			)
				throw new Response("Domain not found", { status: 404 });
			const local = input.localPart.toLowerCase();
			const [box] =
				await tx.CreateMailboxDuplicate`SELECT id FROM mailboxes WHERE domain_id=${domain.id} AND local_part=${local} LIMIT 1`;
			if (box) throw new Response("Mailbox already exists", { status: 409 });
			const [alias] =
				await tx.CreateMailboxAliasDuplicate`SELECT id FROM mailbox_aliases WHERE domain_id=${domain.id} AND local_part=${local} LIMIT 1`;
			if (alias)
				throw new Response("An alias already uses this address", {
					status: 409,
				});
			const mailboxId = id("mbx");
			await tx.CreateManagedMailbox`INSERT INTO mailboxes(id,user_id,domain_id,local_part,display_name,type,created_at) VALUES(${mailboxId},${ownerId},${domain.id},${local},${input.displayName ?? null},${type},${seconds()})`;
			// The installed relay forwards this domain; the server resolves these rows.
			return { id: mailboxId, address: `${local}@${domain.hostname}`, type };
		}),
	);
}
export async function deleteMailbox(user: User, mailboxId: string) {
	await withDatabase((sql) =>
		sql.begin(async (tx) => {
			await tx.DeleteMailboxFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
			const actor = await liveActor(tx, user);
			const [box] =
				await tx.DeleteManagedMailboxOwner`SELECT b.user_id,u.created_by_user_id FROM mailboxes b JOIN users u ON u.id=b.user_id WHERE b.id=${mailboxId}`;
			if (!box) throw new Response("Mailbox not found", { status: 404 });
			const own = box.user_id === actor.id;
			if (
				!(own && (actor.is_primary_admin || actor.can_manage_mailboxes)) &&
				!(
					actor.role === "admin" &&
					(own || box.created_by_user_id === actor.id)
				)
			)
				throw new Response("Forbidden", { status: 403 });
			// Source deletion cascades mailbox configuration and leaves message/object
			// rows and existing outbound-job state intact through their foreign keys.
			await tx.DeleteManagedMailbox`DELETE FROM mailboxes WHERE id=${mailboxId}`;
		}),
	);
}
export async function sharingAdmin(user: User, context?: AppSQL) {
	const check = async (sql: AppSQL) => {
		const [actor] =
			await sql.MailboxSharingActor`SELECT id,role FROM users WHERE id=${user.id} AND disabled=0`;
		if (!actor || actor.role !== "admin")
			throw new Response("Forbidden", { status: 403 });
		const [license] =
			await sql.MailboxSharingLicense`SELECT plan,state FROM license_settings WHERE id='default'`;
		if (!license) {
			await sql.MailboxSharingInitialize`INSERT INTO license_settings(id,instance_id,updated_at) VALUES('default',${crypto.randomUUID()},${seconds()}) ON CONFLICT(id) DO NOTHING`;
		}
		if (
			!license ||
			license.state !== "active" ||
			!["pro", "team"].includes(license.plan)
		)
			throw new Response(
				"A Pro or Team license is required to manage accounts",
				{ status: 403 },
			);
		if (license.plan !== "team")
			throw new Response("A Team license is required to share inboxes", {
				status: 403,
			});
		return actor;
	};
	return context ? check(context) : withDatabase(check);
}
async function sharedMailbox(sql: AppSQL, mailboxId: string, userId: string) {
	const [box] =
		await sql.MailboxSharingBox`SELECT id FROM mailboxes WHERE id=${mailboxId} AND user_id=${userId} AND type='shared' LIMIT 1`;
	if (!box) throw new Response("Shared inbox not found", { status: 404 });
	return box;
}
export async function sharedMailboxMembers(user: User, mailboxId: string) {
	return withDatabase(async (sql) => {
		const actor = await sharingAdmin(user, sql);
		await sharedMailbox(sql, mailboxId, actor.id);
		const [members, availableUsers] = await Promise.all([
			sql.NativeSharedMembers`SELECT a.id,a.user_id,u.email,u.name,a.permission,a.created_at FROM mailbox_access a JOIN users u ON u.id=a.user_id WHERE a.mailbox_id=${mailboxId}`,
			sql.NativeShareUsers`SELECT id,email,name,role FROM users WHERE created_by_user_id=${actor.id} AND disabled=0`,
		]);
		return { members, availableUsers };
	});
}
export async function grantMailbox(
	user: User,
	mailboxId: string,
	targetId: string,
	permission: z.output<typeof mailboxAccessSchema>["permission"],
) {
	await withDatabase((sql) =>
		sql.begin(async (tx) => {
			await tx.GrantMailboxFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
			const actor = await sharingAdmin(user, tx);
			await sharedMailbox(tx, mailboxId, actor.id);
			const [target] =
				await tx.NativeShareTarget`SELECT id FROM users WHERE id=${targetId} AND created_by_user_id=${actor.id} AND disabled=0`;
			if (!target) throw new Response("Account not found", { status: 404 });
			await tx.NativeGrantShare`INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_by_user_id,created_at) VALUES(${id("mac")},${mailboxId},${target.id},${permission},${actor.id},${seconds()}) ON CONFLICT(mailbox_id,user_id) DO UPDATE SET permission=excluded.permission,created_by_user_id=excluded.created_by_user_id`;
		}),
	);
}
export async function revokeMailbox(
	user: User,
	mailboxId: string,
	targetId: string,
) {
	await withDatabase((sql) =>
		sql.begin(async (tx) => {
			await tx.RevokeMailboxFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
			const actor = await sharingAdmin(user, tx);
			await sharedMailbox(tx, mailboxId, actor.id);
			await tx.NativeRevokeShare`DELETE FROM mailbox_access WHERE mailbox_id=${mailboxId} AND user_id=${targetId}`;
		}),
	);
}
