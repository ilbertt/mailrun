import { test, expect, beforeEach, afterEach } from "bun:test";
import bcrypt from "bcryptjs";
import { fixture, owner, stranger, enableTeamSharing } from "./fixtures";
import { dispatchMailApi } from "../src/server/api/mail";
import { mfaApi } from "../src/server/api/settings-mfa";
import { settingsApi } from "../src/server/api/settings";
import { createSession, getUser, hash } from "../src/server/auth/service";
import {
	issueLoginChallenge,
	verifyLoginChallenge,
} from "../src/server/auth/browser-accounts";
import { totp } from "../src/server/auth/totp";
import { listMailboxes, getThread } from "../src/server/mail/repository";
import { mailboxAccess } from "../src/server/mail/access";
import { licenseStatus } from "../src/server/licenses";
let state: Awaited<ReturnType<typeof fixture>>;
const password = "a synthetic password";
beforeEach(async () => {
	state = await fixture();
	state.db
		.query("UPDATE users SET password_hash=? WHERE id=?")
		.run(await bcrypt.hash(password, 4), owner.id);
});
afterEach(async () => {
	await state.close();
});
function request(path: string, body?: unknown, token?: string) {
	return new Request("https://mail.example" + path, {
		method:
			body === undefined
				? "GET"
				: path.endsWith("/password") ||
						path.endsWith("/profile") ||
						path.endsWith("/time-zone") ||
						path.endsWith("/forwarding")
					? "PATCH"
					: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: "Bearer " + token } : {}),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}
test("fresh license initialization works without a pre-existing settings row", async () => {
	expect(await licenseStatus()).toMatchObject({
		plan: "community",
		active: false,
	});
	expect(
		state.db
			.query(
				"SELECT instance_id,updated_at FROM license_settings WHERE id='default'",
			)
			.get(),
	).toMatchObject({
		updated_at: expect.any(Number),
		instance_id: expect.any(String),
	});
});
test("sharing requires Team and a shared mailbox; owning a domain does not grant access to another account mail", async () => {
	state.db.exec(
		"INSERT INTO mailbox_access (id,mailbox_id,user_id,permission,created_at) VALUES ('share','mailbox','stranger','full_access',1)",
	);
	expect(await listMailboxes(stranger)).toEqual([]);
	await expect(mailboxAccess(stranger, "mailbox")).rejects.toThrow(
		"permission",
	);
	enableTeamSharing(state.db);
	expect((await listMailboxes(stranger)).map((box) => box.id)).toEqual([
		"mailbox",
	]);
	state.db.exec("UPDATE mailboxes SET type='personal'");
	expect(await listMailboxes(stranger)).toEqual([]);
	state.db.exec(
		"UPDATE mailboxes SET user_id='stranger'; UPDATE messages SET user_id='stranger'",
	);
	expect(await listMailboxes(owner)).toEqual([]);
	await expect(getThread(owner, "message")).rejects.toThrow("not found");
});
test("MFA enrollment verifies both factors, revokes other sessions and consumes login challenges atomically", async () => {
	const keep = await createSession(owner.id),
		other = await createSession(owner.id);
	const started = await mfaApi(
		request("/api/settings/mfa/enroll", { password }, keep),
		owner,
	);
	const enrollment = await started!.json();
	expect(enrollment.qrSvg).toContain("<svg");
	expect(
		state.db.query("SELECT totp_enabled FROM users WHERE id=?").get(owner.id),
	).toEqual({ totp_enabled: 0 });
	const confirmed = await mfaApi(
		request(
			"/api/settings/mfa/confirm",
			{ code: await totp(enrollment.secret) },
			keep,
		),
		owner,
	);
	const result = await confirmed!.json();
	expect(result.recoveryCodes).toHaveLength(8);
	expect(await getUser(other)).toBeNull();
	expect(await getUser(keep)).not.toBeNull();
	const challenge = await issueLoginChallenge(owner.email);
	const attempts = await Promise.allSettled([
		verifyLoginChallenge(challenge, result.recoveryCodes[0]),
		verifyLoginChallenge(challenge, result.recoveryCodes[0]),
	]);
	expect(
		attempts.filter((result) => result.status === "fulfilled"),
	).toHaveLength(1);
	expect(
		state.db
			.query(
				"SELECT count(*) AS used FROM mfa_recovery_codes WHERE used_at IS NOT NULL",
			)
			.get(),
	).toEqual({ used: 1 });
	const retry = await issueLoginChallenge(owner.email);
	await expect(
		verifyLoginChallenge(retry, result.recoveryCodes[0]),
	).rejects.toMatchObject({ status: 401 });
	expect(
		await verifyLoginChallenge(retry, await totp(enrollment.secret)),
	).toHaveProperty("token");
});
test("recovery regeneration invalidates old codes and disabling MFA clears secrets and outstanding challenges", async () => {
	const enrolled = await (await mfaApi(
		request("/api/settings/mfa/enroll", { password }),
		owner,
	))!.json();
	const confirmed = await (await mfaApi(
		request("/api/settings/mfa/confirm", { code: await totp(enrolled.secret) }),
		owner,
	))!.json();
	const next = await (await mfaApi(
		request("/api/settings/mfa/recovery-codes", { password }),
		owner,
	))!.json();
	const challenge = await issueLoginChallenge(owner.email);
	await expect(
		verifyLoginChallenge(challenge, confirmed.recoveryCodes[0]),
	).rejects.toMatchObject({ status: 401 });
	await mfaApi(
		request("/api/settings/mfa/disable", {
			password,
			code: next.recoveryCodes[0],
		}),
		owner,
	);
	expect(
		state.db
			.query("SELECT totp_enabled,totp_secret FROM users WHERE id=?")
			.get(owner.id),
	).toEqual({ totp_enabled: 0, totp_secret: null });
	expect(
		state.db.query("SELECT count(*) AS total FROM mfa_recovery_codes").get(),
	).toEqual({ total: 0 });
	await expect(
		verifyLoginChallenge(challenge, await totp(enrolled.secret)),
	).rejects.toMatchObject({ status: 401 });
});
test("password change preserves the active session, invalidates reset links and rejects the old password", async () => {
	const keep = await createSession(owner.id),
		other = await createSession(owner.id);
	state.db
		.query(
			"INSERT INTO password_reset_tokens (id,user_id,token_hash,expires_at,created_at) VALUES ('reset','owner',?,9999999999,1)",
		)
		.run(await hash("old-reset"));
	await settingsApi(
		request(
			"/api/settings/password",
			{ currentPassword: password, newPassword: "replacement password" },
			keep,
		),
		owner,
	);
	expect(await getUser(keep)).not.toBeNull();
	expect(await getUser(other)).toBeNull();
	expect(
		state.db.query("SELECT count(*) AS total FROM password_reset_tokens").get(),
	).toEqual({ total: 0 });
	await expect(
		settingsApi(
			request(
				"/api/settings/password",
				{ currentPassword: password, newPassword: "another new password" },
				keep,
			),
			owner,
		),
	).rejects.toMatchObject({ status: 400 });
});
test("mailbox and rule forms persist the source contracts and cannot cross ownership boundaries", async () => {
	const created = await (
		await dispatchMailApi(
			request("/api/mailboxes", {
				domainId: "domain",
				localPart: "sales",
				displayName: "Sales",
			}),
			owner,
		)
	).json();
	const detail = await (
		await dispatchMailApi(
			new Request(`https://mail.example/api/mailboxes/${created.id}`, {
				method: "PATCH",
				body: JSON.stringify({
					signature: "Regards",
					autoReplyEnabled: true,
					autoReplySubject: "Away",
					autoReplyBody: "Back soon",
				}),
			}),
			owner,
		)
	).json();
	expect(detail.mailbox).toMatchObject({
		signature: "Regards",
		autoReplyEnabled: true,
		autoReplySubject: "Away",
	});
	await dispatchMailApi(
		request(`/api/mailboxes/${created.id}/aliases`, {
			domainId: "domain",
			localPart: "billing",
		}),
		owner,
	);
	const aliases = await (
		await dispatchMailApi(
			request(`/api/mailboxes/${created.id}/aliases`),
			owner,
		)
	).json();
	expect(aliases.aliases[0]).toMatchObject({
		localPart: "billing",
		hostname: "example.com",
	});
	await expect(
		dispatchMailApi(request(`/api/mailboxes/${created.id}`), stranger),
	).rejects.toThrow("permission");
	const rule = await (
		await dispatchMailApi(
			request("/api/routing-rules", {
				mailboxId: created.id,
				matchField: "title",
				matchOperator: "contains",
				matchValue: "invoice",
				destination: "spam",
			}),
			owner,
		)
	).json();
	expect(rule.id).toBeString();
	const listed = await (
		await dispatchMailApi(
			request("/api/routing-rules?mailboxId=" + created.id),
			owner,
		)
	).json();
	expect(listed.rules[0]).toMatchObject({
		action: "spam",
		matchValue: "invoice",
	});
});
