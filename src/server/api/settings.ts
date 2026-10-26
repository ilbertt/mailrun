import { syncPersonalIdentity } from "../mail/contacts";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { withDatabase, seconds } from "../db";
import type { User } from "../../shared/contracts";
import {
	updateProfileSchema,
	updateForwardingEmailSchema,
	changePasswordSchema,
	updateTrashRetentionSettingsSchema,
} from "../../lib/validators";
import { licenseEntitlements } from "../licenses";
import { isValidTimeZone, normalizeTimeZone } from "../../lib/time/utils";
import { hash, rateLimit } from "../auth/service";
import { readLimitedBody } from "../mail/inbound";
import { mfaApi } from "./settings-mfa";
export function sessionToken(request: Request) {
	return (
		request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ??
		request.headers.get("cookie")?.match(/(?:^|;\s*)ep_session=([^;]+)/)?.[1]
	);
}
export async function currentProfile(user: User) {
	const [row] = await withDatabase(
		(sql) =>
			sql.NativeAccountProfile`SELECT id,name,email,role,time_zone,reset_email,forwarding_email,avatar_key,keyboard_shortcuts_enabled,is_primary_admin,can_manage_mailboxes,can_manage_domains,can_manage_users,spam_protection_enabled,show_full_recipient_addresses,totp_enabled,trash_retention_days FROM users WHERE id=${user.id} AND disabled=0`,
	);
	if (!row) throw new Response("Unauthorized", { status: 401 });
	return row;
}
export async function settingsApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	const path = new URL(request.url).pathname,
		method = request.method;
	if (!path.startsWith("/api/settings/")) return null;
	const mfa = await mfaApi(request, user);
	if (mfa) return mfa;
	const json = (value: unknown) =>
		Response.json(value, { headers: { "Cache-Control": "no-store" } });
	const read = async () =>
		JSON.parse(
			new TextDecoder().decode(await readLimitedBody(request, 16 * 1024)),
		);
	const row = await currentProfile(user);
	const preference =
		path === "/api/settings/spam"
			? "spam"
			: path === "/api/settings/recipient-addresses"
				? "recipient"
				: path === "/api/settings/shortcuts"
					? "shortcuts"
					: null;
	if (preference) {
		if (method === "GET")
			return json({
				enabled: !!(preference === "spam"
					? row.spam_protection_enabled
					: preference === "recipient"
						? row.show_full_recipient_addresses
						: row.keyboard_shortcuts_enabled),
			});
		if (method === "PATCH") {
			const { enabled } = z
				.object({ enabled: z.boolean() })
				.parse(await read());
			if (preference === "spam")
				await withDatabase(
					(sql) =>
						sql.NativeSetSpam`UPDATE users SET spam_protection_enabled=${enabled ? 1 : 0} WHERE id=${user.id}`,
				);
			else if (preference === "recipient")
				await withDatabase(
					(sql) =>
						sql.NativeSetRecipientAddresses`UPDATE users SET show_full_recipient_addresses=${enabled ? 1 : 0} WHERE id=${user.id}`,
				);
			else
				await withDatabase(
					(sql) =>
						sql.NativeSetShortcuts`UPDATE users SET keyboard_shortcuts_enabled=${enabled ? 1 : 0} WHERE id=${user.id}`,
				);
			return json({ enabled });
		}
	}
	if (path === "/api/settings/trash-retention") {
		if (method === "GET") return json({ days: row.trash_retention_days });
		if (method === "PATCH") {
			const { days } = updateTrashRetentionSettingsSchema.parse(await read());
			await withDatabase(
				(sql) =>
					sql.NativeSetRetention`UPDATE users SET trash_retention_days=${days} WHERE id=${user.id}`,
			);
			return json({ days });
		}
	}
	if (path === "/api/settings/time-zone" && method === "PATCH") {
		const { timeZone } = z
			.object({
				timeZone: z
					.string()
					.trim()
					.min(1)
					.max(80)
					.refine(isValidTimeZone, "Choose a valid IANA timezone")
					.nullable(),
			})
			.parse(await read());
		const value = timeZone ? normalizeTimeZone(timeZone) : null;
		await withDatabase(
			(sql) =>
				sql.NativeSetTimeZone`UPDATE users SET time_zone=${value} WHERE id=${user.id}`,
		);
		return json({ timeZone: value });
	}
	if (path === "/api/settings/forwarding" && method === "PATCH") {
		const { forwardingEmail } = updateForwardingEmailSchema.parse(await read());
		if (!(await licenseEntitlements()).canForwardEmail)
			throw new Response(
				"A Pro or Team license is required for email forwarding",
				{ status: 403 },
			);
		await withDatabase(
			(sql) =>
				sql.NativeProfileForwarding`UPDATE users SET forwarding_email=${forwardingEmail} WHERE id=${user.id}`,
		);
		return json({ forwardingEmail });
	}
	if (path === "/api/settings/profile" && method === "PATCH") {
		const input = updateProfileSchema.parse(await read()),
			canForwardEmail = (await licenseEntitlements()).canForwardEmail;
		if (
			!canForwardEmail &&
			input.forwardingEmail &&
			input.forwardingEmail !== row.forwarding_email
		)
			throw new Response(
				"A Pro or Team license is required for email forwarding",
				{ status: 403 },
			);
		const forwardingEmail =
			input.forwardingEmail === undefined
				? row.forwarding_email
				: input.forwardingEmail;
		await withDatabase((sql) =>
			sql.begin(async (tx) => {
				await tx.NativeSetProfile`UPDATE users SET name=${input.name},reset_email=${input.resetEmail},forwarding_email=${forwardingEmail} WHERE id=${user.id}`;
				await tx.NativeSyncPrimaryMailbox`UPDATE mailboxes SET display_name=${input.name},avatar_key=${row.avatar_key} WHERE user_id=${user.id} AND type='personal' AND EXISTS(SELECT 1 FROM domains d WHERE d.id=mailboxes.domain_id AND lower(mailboxes.local_part||'@'||d.hostname)=lower(${row.email}))`;
			}),
		);
		await syncPersonalIdentity(user.id, input.name, row.avatar_key);
		return json({
			user: {
				id: user.id,
				email: row.email,
				name: input.name,
				resetEmail: input.resetEmail,
				forwardingEmail,
				canForwardEmail,
			},
		});
	}
	if (path === "/api/settings/password" && method === "PATCH") {
		rateLimit("password:" + user.id);
		const input = changePasswordSchema.parse(await read());
		const [secret] = await withDatabase(
			(sql) =>
				sql.NativePasswordHash`SELECT password_hash FROM users WHERE id=${user.id} AND disabled=0`,
		);
		if (
			!secret ||
			!(await bcrypt.compare(input.currentPassword, secret.password_hash))
		)
			throw new Response("Current password is incorrect", { status: 400 });
		if (await bcrypt.compare(input.newPassword, secret.password_hash))
			throw new Response(
				"New password must be different from the current password",
				{ status: 400 },
			);
		const digest = await bcrypt.hash(input.newPassword, 12),
			keep = await hash(sessionToken(request) ?? "");
		await withDatabase((sql) =>
			sql.begin(async (tx) => {
				const changed =
					await tx.NativeChangePassword`UPDATE users SET password_hash=${digest} WHERE id=${user.id} AND password_hash=${secret.password_hash} AND disabled=0 RETURNING id`;
				if (!changed.length)
					throw new Response("Account changed. Try again.", { status: 409 });
				await tx.NativeRevokePasswordSessions`DELETE FROM sessions WHERE user_id=${user.id} AND token_hash<>${keep}`;
				await tx.NativeRevokePasswordResets`DELETE FROM password_reset_tokens WHERE user_id=${user.id}`;
				await tx.NativeRevokePasswordChallenges`DELETE FROM login_challenges WHERE user_id=${user.id}`;
			}),
		);
		return json({ ok: true });
	}
	return null;
}
