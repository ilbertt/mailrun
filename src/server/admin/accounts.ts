import bcrypt from "bcryptjs";
import type { User } from "../../shared/contracts";
import {
	createUserAccountSchema,
	updateManagedAccountSchema,
} from "../../lib/validators";
import { withDatabase, id, seconds, type AppSQL } from "../db";
import { normalizeLocalPart } from "../mail/routing";
import { assignBookingUsername } from "../calendar/booking";
export async function adminWrite<T>(run: (sql: AppSQL) => Promise<T>) {
	return withDatabase((sql) =>
		sql.begin(async (tx) => {
			await tx.NativeAdminWriteFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
			return run(tx);
		}),
	);
}
export async function accountsContext(sql: AppSQL, user: User) {
	const [actor] =
		await sql.NativeManagedAccountActor`SELECT id,role,is_primary_admin,can_manage_users,disabled FROM users WHERE id=${user.id}`;
	if (!actor || actor.disabled || actor.role !== "admin")
		throw new Response("Forbidden", { status: 403 });
	const [license] =
		await sql.NativeAccountsLicense`SELECT plan,state,seat_limit FROM license_settings WHERE id='default'`;
	if (
		!license ||
		license.state !== "active" ||
		!["pro", "team"].includes(license.plan)
	)
		throw new Response("A Pro or Team license is required to manage accounts", {
			status: 403,
		});
	return {
		actor,
		seatLimit: license.plan === "pro" ? license.seat_limit : null,
	};
}
export async function managedAccount(sql: AppSQL, accountId: string) {
	const [account] =
		await sql.NativeManagedAccountRecord`SELECT * FROM users WHERE id=${accountId}`;
	if (!account) throw new Response("Account not found", { status: 404 });
	return account;
}
type Account = Awaited<ReturnType<typeof managedAccount>>;
function dto(account: Account) {
	return {
		id: account.id,
		email: account.email,
		name: account.name,
		resetEmail: account.reset_email,
		role: account.role,
		isPrimaryAdmin: !!account.is_primary_admin,
		disabled: !!account.disabled,
		hasAvatar: !!account.avatar_key,
		canManageMailboxes: !!account.can_manage_mailboxes,
		canManageDomains: !!account.can_manage_domains,
		canManageUsers: !!account.can_manage_users,
		createdAt: new Date(account.created_at * 1000).toISOString(),
	};
}
export function canEditAccount(
	actor: Awaited<ReturnType<typeof accountsContext>>["actor"],
	account: Account,
) {
	return (
		!!actor.is_primary_admin ||
		(!!actor.can_manage_users &&
			account.role === "user" &&
			!account.is_primary_admin)
	);
}
export async function listAccounts(user: User) {
	return withDatabase(async (sql) => {
		const ctx = await accountsContext(sql, user),
			rows =
				await sql.NativeAccountsList`SELECT * FROM users ORDER BY created_at DESC,rowid`;
		return {
			accounts: rows.map(dto),
			seats: {
				limit: ctx.seatLimit,
				used: rows.filter((row) => !row.disabled).length,
			},
		};
	});
}
export async function accountDetails(user: User, accountId: string) {
	return withDatabase(async (sql) => {
		const { actor } = await accountsContext(sql, user),
			account = await managedAccount(sql, accountId);
		return {
			account: {
				...dto(account),
				forwardingEmail: account.forwarding_email,
				canForwardEmail: true,
				editable: canEditAccount(actor, account),
				canChangeRole: !!actor.is_primary_admin,
				canTransferPrimary:
					!!actor.is_primary_admin &&
					!account.is_primary_admin &&
					!account.disabled,
			},
		};
	});
}
async function requireSeat(sql: AppSQL, limit: number | null) {
	if (limit === null) return;
	const [row] =
		await sql.NativeAccountSeatUsage`SELECT count(*) AS total FROM users WHERE disabled=0`;
	if (Number(row?.total ?? 0) >= limit)
		throw new Response(
			`All ${limit} account seats of this license are in use. Disable an account or add seats to your license`,
			{ status: 403 },
		);
}
export async function createAccount(user: User, value: unknown) {
	const input = createUserAccountSchema.parse(value);
	await withDatabase(async (sql) => {
		const { actor } = await accountsContext(sql, user);
		if (!actor.is_primary_admin && !actor.can_manage_users)
			throw new Response("You do not have permission to manage users", {
				status: 403,
			});
	});
	const passwordHash = await bcrypt.hash(input.password, 12),
		username = input.username.toLowerCase().trim();
	const account = await adminWrite(async (sql) => {
		const { actor, seatLimit } = await accountsContext(sql, user);
		if (
			!actor.is_primary_admin &&
			(!actor.can_manage_users || input.role === "admin")
		)
			throw new Response("Only the primary admin can create admin accounts", {
				status: 403,
			});
		await requireSeat(sql, seatLimit);
		const domains =
				await sql.NativeAccountCreateDomains`SELECT id,hostname,status FROM domains WHERE user_id=${user.id}`,
			primary = domains.find((domain) => domain.id === input.domainId);
		if (!primary) throw new Response("Domain not found", { status: 404 });
		const addresses = [
				{ domainId: primary.id, localPart: username },
				...input.aliases,
			],
			seen = new Set<string>();
		for (const [index, address] of addresses.entries()) {
			const domain = domains.find((row) => row.id === address.domainId),
				normalized = normalizeLocalPart(address.localPart);
			if (!domain || (index > 0 && domain.status !== "active"))
				throw new Response(
					"Choose an active alias domain owned by this admin account",
					{ status: 400 },
				);
			if (!normalized)
				throw new Response("Enter a valid address username", { status: 400 });
			const key = normalized + "@" + domain.id;
			if (seen.has(key))
				throw new Response(
					"Each alias must be distinct from the primary address and other aliases",
					{ status: 400 },
				);
			seen.add(key);
		}
		const occupied =
			await sql.NativeAccountOccupiedAddresses`/* @notNull local_part */ SELECT domain_id,local_part FROM mailboxes WHERE domain_id IN(SELECT id FROM domains WHERE user_id=${user.id}) UNION ALL SELECT domain_id,local_part FROM mailbox_aliases WHERE domain_id IN(SELECT id FROM domains WHERE user_id=${user.id})`;
		if (
			occupied.some((address) =>
				seen.has(
					normalizeLocalPart(address.local_part) + "@" + address.domain_id,
				),
			)
		)
			throw new Response(
				"An email address is already assigned to a mailbox or alias",
				{ status: 409 },
			);
		const email = username + "@" + primary.hostname,
			[registered] =
				await sql.NativeAccountRegisteredEmail`SELECT id FROM users WHERE lower(email)=${email}`;
		if (registered)
			throw new Response("Email already registered", { status: 409 });
		const userId = id("usr"),
			mailboxId = id("mbx"),
			[row] =
				await sql.NativeInsertManagedAccount`INSERT INTO users(id,email,name,password_hash,role,created_by_user_id,created_at) VALUES(${userId},${email},${username},${passwordHash},${input.role},${user.id},${seconds()}) RETURNING *`;
		if (!row) throw new Error("Could not create account");
		await sql.NativeInsertManagedPrimaryMailbox`INSERT INTO mailboxes(id,user_id,domain_id,local_part,display_name,use_all_domains,created_at) VALUES(${mailboxId},${userId},${primary.id},${username},${username},${input.useAllDomains ? 1 : 0},${seconds()})`;
		for (const alias of input.aliases)
			await sql.NativeInsertManagedAlias`INSERT INTO mailbox_aliases(id,mailbox_id,domain_id,local_part,created_at) VALUES(${id("als")},${mailboxId},${alias.domainId},${alias.localPart},${seconds()})`;
		await assignBookingUsername(sql, { id: row.id, email: row.email });
		return row;
	});
	return { account: dto(account) };
}
export async function updateAccount(
	user: User,
	accountId: string,
	value: unknown,
) {
	const input = updateManagedAccountSchema.parse(value);
	await withDatabase(async (sql) => {
		const { actor } = await accountsContext(sql, user);
		if (!canEditAccount(actor, await managedAccount(sql, accountId)))
			throw new Response("Only the primary admin can manage admin accounts", {
				status: 403,
			});
	});
	const passwordHash = input.password
		? await bcrypt.hash(input.password, 12)
		: null;
	await adminWrite(async (sql) => {
		const { actor, seatLimit } = await accountsContext(sql, user),
			account = await managedAccount(sql, accountId);
		if (!canEditAccount(actor, account))
			throw new Response("Only the primary admin can manage admin accounts", {
				status: 403,
			});
		if (!actor.is_primary_admin && input.role !== account.role)
			throw new Response("Only the primary admin can change roles", {
				status: 403,
			});
		if (account.disabled && !input.disabled) await requireSeat(sql, seatLimit);
		await sql.NativeUpdateManagedAccount`UPDATE users SET name=${input.name},password_hash=COALESCE(${passwordHash},password_hash),role=${account.is_primary_admin ? "admin" : actor.is_primary_admin ? input.role : account.role},disabled=${account.is_primary_admin ? 0 : input.disabled ? 1 : 0},can_manage_mailboxes=${input.canManageMailboxes ? 1 : 0},can_manage_domains=CASE WHEN ${actor.is_primary_admin && input.canManageDomains !== undefined ? 1 : 0}=1 THEN ${input.canManageDomains ? 1 : 0} ELSE can_manage_domains END,can_manage_users=CASE WHEN ${actor.is_primary_admin && input.canManageUsers !== undefined ? 1 : 0}=1 THEN ${input.canManageUsers ? 1 : 0} ELSE can_manage_users END,forwarding_email=CASE WHEN ${input.forwardingEmail !== undefined ? 1 : 0}=1 THEN ${input.forwardingEmail ?? null} ELSE forwarding_email END WHERE id=${account.id}`;
		await sql.NativeUpdateManagedMailboxNames`UPDATE mailboxes SET display_name=${input.name} WHERE user_id=${account.id} AND type='personal'`;
		if (passwordHash || (!account.is_primary_admin && input.disabled))
			await sql.NativeRevokeManagedSessions`DELETE FROM sessions WHERE user_id=${account.id}`;
		if (passwordHash) {
			await sql.NativeRevokeManagedResetTokens`DELETE FROM password_reset_tokens WHERE user_id=${account.id}`;
			await sql.NativeRevokeManagedLoginChallenges`DELETE FROM login_challenges WHERE user_id=${account.id}`;
		}
	});
	return { ok: true };
}
export async function transferPrimary(user: User, accountId: string) {
	return adminWrite(async (sql) => {
		const { actor } = await accountsContext(sql, user);
		if (!actor.is_primary_admin)
			throw new Response("Only the primary admin can transfer the role", {
				status: 403,
			});
		const target = await managedAccount(sql, accountId);
		if (target.id === actor.id)
			throw new Response("You are already the primary admin", { status: 400 });
		if (target.disabled)
			throw new Response(
				"Enable this account before transferring the primary admin role",
				{ status: 400 },
			);
		await sql.NativeTransferPrimaryAccount`UPDATE users SET is_primary_admin=CASE WHEN id=${target.id} THEN 1 ELSE 0 END,role=CASE WHEN id=${target.id} THEN 'admin' ELSE role END WHERE is_primary_admin=1 OR id=${target.id}`;
		return { ok: true };
	});
}
export async function accountMailboxes(user: User, accountId: string) {
	return withDatabase(async (sql) => {
		await accountsContext(sql, user);
		const account = await managedAccount(sql, accountId);
		if (account.id !== user.id && account.created_by_user_id !== user.id)
			throw new Response("Account not found", { status: 404 });
		const rows =
			await sql.NativeManagedAccountMailboxes`/* @notNull id */ SELECT b.id,b.local_part,b.display_name,b.domain_id,d.hostname FROM mailboxes b JOIN domains d ON d.id=b.domain_id WHERE b.user_id=${accountId}`;
		return {
			mailboxes: rows.map((row) => ({
				id: row.id,
				localPart: row.local_part,
				displayName: row.display_name,
				domainId: row.domain_id,
				hostname: row.hostname,
			})),
		};
	});
}
