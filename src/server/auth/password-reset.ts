import bcrypt from "bcryptjs";
import { withDatabase, id, seconds } from "../db";
import { adminWrite } from "../admin/accounts";
import { hash } from "./service";
import { branding } from "../branding";
import { sendSystemMail, type SystemMail } from "../mail/system";
import { recordAuthActivity } from "./activity";
const escape = (value: string) =>
	value.replace(
		/[&<>"']/g,
		(char) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				char
			] ?? char,
	);
export async function requestPasswordReset(
	email: string,
	origin: string,
	send: (message: SystemMail) => Promise<boolean> = sendSystemMail,
) {
	const [user] = await withDatabase(
		(sql) =>
			sql.NativeResetAccount`SELECT id,email,reset_email FROM users WHERE email=${email.trim().toLowerCase()} AND disabled=0`,
	);
	if (!user?.reset_email) return;
	const token = id("prt"),
		digest = await hash(token);
	await withDatabase(
		(sql) =>
			sql.NativeIssuePasswordReset`INSERT INTO password_reset_tokens(id,user_id,token_hash,expires_at,created_at) VALUES(${id("reset")},${user.id},${digest},${seconds() + 1800},${seconds()})`,
	);
	const { appName } = await branding(),
		link = `${origin}/reset-password?token=${encodeURIComponent(token)}`;
	await send({
		to: user.reset_email,
		subject: `Reset your ${appName} password`,
		text: [
			`Someone asked to reset the password for ${user.email} on ${appName}.`,
			"",
			"Open this link within 30 minutes to choose a new password:",
			link,
			"",
			"If that was not you, you can ignore this message; the password stays as it is.",
		].join("\n"),
		html: `<p>Someone asked to reset the password for <b>${escape(user.email)}</b> on ${escape(appName)}.</p><p>Open this link within 30 minutes to choose a new password:</p><p><a href="${escape(link)}">${escape(link)}</a></p><p>If that was not you, you can ignore this message; the password stays as it is.</p>`,
	});
}
export async function completePasswordReset(
	token: string,
	password: string,
	request: Request,
) {
	const digest = await hash(token),
		[valid] = await withDatabase(
			(sql) =>
				sql.NativeValidPasswordReset`SELECT id FROM password_reset_tokens WHERE token_hash=${digest} AND expires_at>${seconds()} AND used_at IS NULL LIMIT 1`,
		);
	const invalid = {
		ok: false as const,
		error: "This reset link is invalid or has expired. Request a new one.",
	};
	if (!valid) return invalid;
	const passwordHash = await bcrypt.hash(password, 12);
	const userId = await adminWrite(async (sql) => {
		const [claimed] =
			await sql.NativeConsumePasswordReset`UPDATE password_reset_tokens SET used_at=${seconds()} WHERE id=${valid.id} AND token_hash=${digest} AND expires_at>${seconds()} AND used_at IS NULL RETURNING user_id`;
		if (!claimed) return null;
		await sql.NativeResetPassword`UPDATE users SET password_hash=${passwordHash} WHERE id=${claimed.user_id}`;
		await sql.NativeResetRevokeSessions`DELETE FROM sessions WHERE user_id=${claimed.user_id}`;
		await sql.NativeResetRevokeChallenges`DELETE FROM login_challenges WHERE user_id=${claimed.user_id}`;
		return claimed.user_id;
	});
	if (!userId) return invalid;
	await recordAuthActivity("auth.password_reset", userId, request);
	return { ok: true as const };
}
