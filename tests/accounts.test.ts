import { test, expect, beforeEach, afterEach } from "bun:test";
import bcrypt from "bcryptjs";
import { fixture, owner, stranger, enableTeamSharing } from "./fixtures";
import {
	listAccounts,
	accountDetails,
	createAccount,
	updateAccount,
	transferPrimary,
	accountMailboxes,
} from "../src/server/admin/accounts";
import { resolveRouting } from "../src/server/mail/routing";
import { createSession, getUser } from "../src/server/auth/service";
import { accountsApi } from "../src/server/api/accounts";
import type { User } from "../src/shared/contracts";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
	enableTeamSharing(state.db);
});
afterEach(async () => {
	await state.close();
});
const create = (
	username = "new.user",
	overrides: Record<string, unknown> = {},
) =>
	createAccount(owner, {
		username,
		domainId: "domain",
		password: "A test password!",
		...overrides,
	});
const update = (overrides: Record<string, unknown> = {}) => ({
	name: "Updated account",
	role: "user",
	disabled: false,
	canManageMailboxes: false,
	...overrides,
});
const delegated: User = { ...stranger, role: "admin" };
function delegate(canManageUsers = true) {
	state.db
		.query(
			"UPDATE users SET role='admin',can_manage_users=? WHERE id='stranger'",
		)
		.run(canManageUsers ? 1 : 0);
}
test("licensed account creation atomically provisions a personal inbox, aliases and booking username", async () => {
	const result = await create("New.User", {
		useAllDomains: false,
		aliases: [{ domainId: "domain", localPart: "Second.Alias" }],
	});
	const account = result.account;
	expect(account).toMatchObject({
		email: "new.user@example.com",
		name: "new.user",
		role: "user",
		isPrimaryAdmin: false,
		disabled: false,
	});
	const saved = state.db
		.query<
			{
				password_hash: string;
				booking_username: string;
				created_by_user_id: string;
			},
			string
		>(
			"SELECT password_hash,booking_username,created_by_user_id FROM users WHERE id=?",
		)
		.get(account.id)!;
	expect(await bcrypt.compare("A test password!", saved.password_hash)).toBe(
		true,
	);
	expect(saved.created_by_user_id).toBe(owner.id);
	expect(saved.booking_username).toBe("new.user");
	const mailboxes = (await accountMailboxes(owner, account.id)).mailboxes;
	expect(mailboxes).toHaveLength(1);
	expect(mailboxes[0]).toMatchObject({
		localPart: "new.user",
		domainId: "domain",
	});
	const routed = await resolveRouting("secondalias+tag@example.com");
	expect(routed).toMatchObject({
		action: "store",
		mailbox: { user_id: account.id, id: mailboxes[0]!.id },
	});
	expect(await accountDetails(owner, account.id)).toMatchObject({
		account: {
			editable: true,
			canChangeRole: true,
			canTransferPrimary: true,
			canForwardEmail: true,
		},
	});
});
test("normalized address conflicts and invalid alias domains leave no partial user or mailbox", async () => {
	await expect(create("Hello+work")).rejects.toMatchObject({ status: 409 });
	await expect(
		create("unused", {
			aliases: [{ domainId: "domain", localPart: "u.n.u.s.e.d+tag" }],
		}),
	).rejects.toMatchObject({ status: 400 });
	await expect(
		create("unused", {
			aliases: [{ domainId: "not-owned", localPart: "alias" }],
		}),
	).rejects.toMatchObject({ status: 400 });
	expect(state.db.query("SELECT count(*) AS n FROM users").get()).toEqual({
		n: 2,
	});
	expect(state.db.query("SELECT count(*) AS n FROM mailboxes").get()).toEqual({
		n: 1,
	});
});
test("unlicensed users and admins without user-management permission cannot create or edit accounts", async () => {
	await expect(listAccounts(stranger)).rejects.toMatchObject({ status: 403 });
	delegate(false);
	expect((await listAccounts(delegated)).accounts).toHaveLength(2);
	expect((await accountDetails(delegated, owner.id)).account.editable).toBe(
		false,
	);
	await expect(
		createAccount(delegated, {
			username: "denied",
			domainId: "domain",
			password: "A test password!",
		}),
	).rejects.toMatchObject({ status: 403 });
	await expect(
		updateAccount(delegated, owner.id, update()),
	).rejects.toMatchObject({ status: 403 });
	state.db.exec("UPDATE license_settings SET state='inactive'");
	await expect(listAccounts(owner)).rejects.toMatchObject({ status: 403 });
	await expect(create()).rejects.toMatchObject({ status: 403 });
});
test("delegated admins manage plain users, cannot promote them and cannot edit admin privileges", async () => {
	const child = (await create()).account;
	delegate();
	await expect(
		updateAccount(delegated, child.id, update({ role: "admin" })),
	).rejects.toMatchObject({ status: 403 });
	await updateAccount(
		delegated,
		child.id,
		update({
			canManageMailboxes: true,
			canManageDomains: true,
			canManageUsers: true,
		}),
	);
	expect((await accountDetails(owner, child.id)).account).toMatchObject({
		name: "Updated account",
		canManageMailboxes: true,
		canManageDomains: false,
		canManageUsers: false,
	});
	await expect(
		updateAccount(delegated, owner.id, update({ role: "admin" })),
	).rejects.toMatchObject({ status: 403 });
	await updateAccount(
		owner,
		child.id,
		update({ role: "admin", canManageDomains: true, canManageUsers: true }),
	);
	expect((await accountDetails(owner, child.id)).account).toMatchObject({
		role: "admin",
		canManageDomains: true,
		canManageUsers: true,
	});
	await expect(
		updateAccount(delegated, child.id, update({ role: "admin" })),
	).rejects.toMatchObject({ status: 403 });
});
test("seat reservations serialize competing account creations and re-enabling also consumes a seat", async () => {
	state.db.exec("UPDATE license_settings SET plan='pro',seat_limit=3");
	const results = await Promise.allSettled([create("first"), create("second")]);
	expect(
		results.filter((result) => result.status === "fulfilled"),
	).toHaveLength(1);
	expect(
		results.filter((result) => result.status === "rejected")[0],
	).toMatchObject({ reason: { status: 403 } });
	const success = results.find((result) => result.status === "fulfilled")!;
	if (success.status !== "fulfilled") throw new Error("No account created");
	const account = success.value.account;
	expect((await listAccounts(owner)).seats).toEqual({ limit: 3, used: 3 });
	await updateAccount(owner, account.id, update({ disabled: true }));
	expect((await listAccounts(owner)).seats.used).toBe(2);
	await create("replacement");
	await expect(
		updateAccount(owner, account.id, update()),
	).rejects.toMatchObject({ status: 403 });
});
test("password resets revoke existing sessions and outstanding authentication challenges", async () => {
	const account = (await create()).account,
		token = await createSession(account.id);
	expect((await getUser(token))?.id).toBe(account.id);
	state.db
		.query(
			"INSERT INTO password_reset_tokens(id,user_id,token_hash,expires_at,created_at) VALUES ('reset',?,'reset-hash',9999999999,1)",
		)
		.run(account.id);
	state.db
		.query(
			"INSERT INTO login_challenges(id,user_id,token_hash,expires_at,created_at) VALUES ('challenge',?,'challenge-hash',9999999999,1)",
		)
		.run(account.id);
	await updateAccount(
		owner,
		account.id,
		update({ password: "A replacement password!" }),
	);
	expect(await getUser(token)).toBeNull();
	expect(
		state.db.query("SELECT count(*) AS n FROM password_reset_tokens").get(),
	).toEqual({ n: 0 });
	expect(
		state.db.query("SELECT count(*) AS n FROM login_challenges").get(),
	).toEqual({ n: 0 });
	const saved = state.db
		.query<{ password_hash: string }, string>(
			"SELECT password_hash FROM users WHERE id=?",
		)
		.get(account.id)!;
	expect(
		await bcrypt.compare("A replacement password!", saved.password_hash),
	).toBe(true);
});
test("disabling an account revokes sessions and the primary admin remains enabled with active sessions", async () => {
	const account = (await create()).account,
		token = await createSession(account.id);
	await updateAccount(owner, account.id, update({ disabled: true }));
	expect(await getUser(token)).toBeNull();
	expect((await accountDetails(owner, account.id)).account.disabled).toBe(true);
	const ownerToken = await createSession(owner.id);
	await updateAccount(
		owner,
		owner.id,
		update({ disabled: true, role: "user" }),
	);
	expect((await getUser(ownerToken))?.isPrimaryAdmin).toBe(true);
	expect((await accountDetails(owner, owner.id)).account).toMatchObject({
		disabled: false,
		role: "admin",
		isPrimaryAdmin: true,
	});
});
test("primary transfer is atomic and rechecks stale actors instead of permitting a second transfer", async () => {
	const account = (await create()).account;
	delegate();
	await expect(transferPrimary(delegated, account.id)).rejects.toMatchObject({
		status: 403,
	});
	await transferPrimary(owner, account.id);
	expect(
		(
			await accountDetails(
				{ ...owner, id: account.id, email: account.email },
				account.id,
			)
		).account,
	).toMatchObject({ role: "admin", isPrimaryAdmin: true });
	expect(
		state.db
			.query("SELECT count(*) AS n FROM users WHERE is_primary_admin=1")
			.get(),
	).toEqual({ n: 1 });
	await expect(transferPrimary(owner, stranger.id)).rejects.toMatchObject({
		status: 403,
	});
	await expect(
		updateAccount(owner, account.id, update()),
	).rejects.toMatchObject({ status: 403 });
});
test("mailbox inventory and retired access endpoints retain the original ownership rules and status", async () => {
	const account = (await create()).account;
	await expect(accountMailboxes(owner, stranger.id)).rejects.toMatchObject({
		status: 404,
	});
	expect((await accountMailboxes(owner, account.id)).mailboxes).toHaveLength(1);
	delegate();
	await expect(accountMailboxes(delegated, account.id)).rejects.toMatchObject({
		status: 404,
	});
	const response = await accountsApi(
		new Request(
			"http://localhost/api/accounts/" + account.id + "/mailbox-access",
		),
		owner,
	);
	expect(response?.status).toBe(410);
});

test("a failure assigning the booking username rolls back user, inbox and aliases together", async () => {
	state.db.exec(
		"CREATE TRIGGER fixture_fail_booking BEFORE UPDATE OF booking_username ON users BEGIN SELECT RAISE(ABORT,'fixture booking failure'); END",
	);
	await expect(
		create("rollback", {
			aliases: [{ domainId: "domain", localPart: "rollback-alias" }],
		}),
	).rejects.toThrow("fixture booking failure");
	expect(state.db.query("SELECT count(*) AS n FROM users").get()).toEqual({
		n: 2,
	});
	expect(state.db.query("SELECT count(*) AS n FROM mailboxes").get()).toEqual({
		n: 1,
	});
	expect(
		state.db.query("SELECT count(*) AS n FROM mailbox_aliases").get(),
	).toEqual({ n: 0 });
});
