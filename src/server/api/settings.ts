import { normalizeTrashRetentionDays } from "../../lib/email/trash-retention-utils";
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
import {
	isValidTimeZone,
	normalizeTimeZone,
	getRequestTimeZone,
} from "../../lib/time/utils";
import { hash, rateLimit } from "../auth/service";
import { readLimitedBody } from "../mail/inbound";
import { mfaApi } from "./settings-mfa";
import { sessionToken } from "../auth/request-token";
export { sessionToken };
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
	const json = (value: unknown, status = 200) =>
		Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
	const read = async () =>
		JSON.parse(
			new TextDecoder().decode(await readLimitedBody(request, 16 * 1024)),
		);
	// These source handlers return flattened validation errors inside `error`.
	const readSetting = async <Schema extends z.ZodType>(
		schema: Schema,
		errorMessage?: string,
	): Promise<z.output<Schema> | Response> => {
		try {
			return schema.parse(await read());
		} catch (error) {
			if (error instanceof z.ZodError)
				return json({ error: errorMessage ?? error.flatten() }, 400);
			if (error instanceof SyntaxError)
				return json({ error: errorMessage ?? "Invalid request" }, 400);
			throw error;
		}
	};
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
			const parsed = await readSetting(z.object({ enabled: z.boolean() }));
			if (parsed instanceof Response) return parsed;
			const { enabled } = parsed;
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
		if (method === "GET")
			return json({
				days: normalizeTrashRetentionDays(row.trash_retention_days),
			});
		if (method === "PATCH") {
			const parsed = await readSetting(updateTrashRetentionSettingsSchema);
			if (parsed instanceof Response) return parsed;
			const { days } = parsed;
			await withDatabase(
				(sql) =>
					sql.NativeSetRetention`UPDATE users SET trash_retention_days=${days} WHERE id=${user.id}`,
			);
			return json({ days });
		}
	}
	if (path === "/api/settings/time-zone" && method === "PATCH") {
		const parsed = await readSetting(
			z.object({
				timeZone: z
					.string()
					.trim()
					.min(1)
					.max(80)
					.refine(isValidTimeZone, "Choose a valid IANA timezone")
					.nullable(),
			}),
			"Choose a valid timezone",
		);
		if (parsed instanceof Response) return parsed;
		const value = parsed.timeZone ? normalizeTimeZone(parsed.timeZone) : null;
		await withDatabase((sql) =>
			sql.begin(async (tx) => {
				await tx.NativeTimeZoneWriteFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
				const [current] =
					await tx.NativeTimeZoneCurrent`SELECT time_zone FROM users WHERE id=${user.id} AND disabled=0`;
				if (!current) throw new Response("Unauthorized", { status: 401 });
				const previous = getRequestTimeZone(request, current.time_zone);
				await tx.NativeFreezeLegacyCalendarZones`UPDATE calendar_events SET time_zone=${previous} WHERE user_id=${user.id} AND time_zone IS NULL AND repeat<>'none'`;
				await tx.NativeSetTimeZone`UPDATE users SET time_zone=${value} WHERE id=${user.id}`;
			}),
		);
		return json({ timeZone: value });
	}
	if (path === "/api/settings/forwarding" && method === "PATCH") {
		const parsed = await readSetting(updateForwardingEmailSchema);
		if (parsed instanceof Response) return parsed;
		const { forwardingEmail } = parsed;
		await licenseEntitlements();
		await withDatabase((sql) =>
			sql.begin(async (tx) => {
				await tx.NativeForwardingWriteFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
				const [actor] =
					await tx.NativeForwardingActor`SELECT id FROM users WHERE id=${user.id} AND disabled=0`;
				if (!actor) throw new Response("Unauthorized", { status: 401 });
				const [license] =
					await tx.NativeForwardingLicense`SELECT plan,state FROM license_settings WHERE id='default'`;
				if (
					license?.state !== "active" ||
					!["pro", "team"].includes(license.plan)
				)
					throw new Response(
						"A Pro or Team license is required for email forwarding",
						{ status: 403 },
					);
				await tx.NativeProfileForwarding`UPDATE users SET forwarding_email=${forwardingEmail} WHERE id=${user.id}`;
			}),
		);
		return json({ forwardingEmail });
	}
	if (path === "/api/settings/profile" && method === "PATCH") {
		const input = await readSetting(updateProfileSchema);
		if (input instanceof Response) return input;
		await licenseEntitlements();
		const profile = await withDatabase((sql) =>
			sql.begin(async (tx) => {
				await tx.NativeProfileWriteFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
				const [current] =
					await tx.NativeProfileCurrent`SELECT email,avatar_key,forwarding_email FROM users WHERE id=${user.id} AND disabled=0`;
				if (!current) throw new Response("Unauthorized", { status: 401 });
				const [license] =
					await tx.NativeProfileLicense`SELECT plan,state FROM license_settings WHERE id='default'`;
				const entitled =
					license?.state === "active" &&
					(license.plan === "pro" || license.plan === "team");
				if (
					!entitled &&
					input.forwardingEmail &&
					input.forwardingEmail !== current.forwarding_email
				)
					throw new Response(
						"A Pro or Team license is required for email forwarding",
						{ status: 403 },
					);
				const forwardingEmail =
					input.forwardingEmail === undefined
						? current.forwarding_email
						: input.forwardingEmail;
				await syncPersonalIdentity(user.id, input.name, current.avatar_key, tx);
				await tx.NativeSetProfile`UPDATE users SET reset_email=${input.resetEmail},forwarding_email=${forwardingEmail} WHERE id=${user.id}`;
				return {
					email: current.email,
					forwardingEmail,
					canForwardEmail: entitled,
				};
			}),
		);
		return json({
			user: {
				id: user.id,
				email: profile.email,
				name: input.name,
				resetEmail: input.resetEmail,
				forwardingEmail: profile.forwardingEmail,
				canForwardEmail: profile.canForwardEmail,
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
