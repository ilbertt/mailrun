import bcrypt from "bcryptjs";
import QRCode from "qrcode";
import { z } from "zod";
import { withDatabase, id, seconds, type AppSQL } from "../db";
import type { User } from "../../shared/contracts";
import { hash, rateLimit } from "../auth/service";
import { generateTotpSecret, buildOtpauthUrl, verifyTotp } from "../auth/totp";
import { branding } from "../branding";
import { readLimitedBody } from "../mail/inbound";
import { sessionToken } from "./settings";
function recoveryCodes() {
	const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
	return Array.from({ length: 8 }, () => {
		const chars = Array.from(
			crypto.getRandomValues(new Uint8Array(10)),
			(byte) => alphabet[byte % alphabet.length],
		).join("");
		return chars.slice(0, 5) + "-" + chars.slice(5);
	});
}
async function replaceCodes(
	sql: AppSQL,
	userId: string,
	codes: { value: string; digest: string }[],
) {
	await sql.NativeClearRecovery`DELETE FROM mfa_recovery_codes WHERE user_id=${userId}`;
	for (const code of codes)
		await sql.NativeInsertRecovery`INSERT INTO mfa_recovery_codes (id,user_id,code_hash,created_at) VALUES (${id("rc")},${userId},${code.digest},${seconds()})`;
}
export async function mfaApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	const path = new URL(request.url).pathname,
		method = request.method;
	if (!path.startsWith("/api/settings/mfa")) return null;
	const [row] = await withDatabase(
		(sql) =>
			sql.NativeMfaSettings`SELECT id,email,password_hash,disabled,totp_secret,totp_enabled,totp_confirmed_at FROM users WHERE id=${user.id}`,
	);
	if (!row || row.disabled) throw new Response("Unauthorized", { status: 401 });
	const json = (value: unknown) =>
		Response.json(value, { headers: { "Cache-Control": "no-store" } });
	if (path === "/api/settings/mfa" && method === "GET") {
		const [count] = await withDatabase(
			(sql) =>
				sql.NativeRecoveryCount`SELECT count(*) AS total FROM mfa_recovery_codes WHERE user_id=${user.id} AND used_at IS NULL`,
		);
		return json({
			enabled: !!row.totp_enabled,
			confirmedAt:
				row.totp_confirmed_at == null
					? null
					: new Date(row.totp_confirmed_at * 1000).toISOString(),
			recoveryCodesLeft: row.totp_enabled ? (count?.total ?? 0) : 0,
		});
	}
	if (method !== "POST") return null;
	rateLimit("mfa-settings:" + user.id);
	const data: unknown = JSON.parse(
		new TextDecoder().decode(await readLimitedBody(request, 16 * 1024)),
	);
	const keep = await hash(sessionToken(request) ?? "");
	if (path === "/api/settings/mfa/enroll") {
		const { password } = z
			.object({ password: z.string().min(1).max(128) })
			.parse(data);
		if (!(await bcrypt.compare(password, row.password_hash)))
			throw new Response("Password is incorrect", { status: 400 });
		if (row.totp_enabled)
			throw new Response("Two-factor authentication is already on", {
				status: 400,
			});
		const secret = generateTotpSecret(),
			otpauthUrl = buildOtpauthUrl({
				issuer: (await branding()).appName,
				account: row.email,
				secret,
			});
		const changed = await withDatabase(
			(sql) =>
				sql.NativeEnrollMfa`UPDATE users SET totp_secret=${secret},totp_enabled=0,totp_confirmed_at=NULL WHERE id=${user.id} AND password_hash=${row.password_hash} AND disabled=0 AND totp_enabled=0 RETURNING id`,
		);
		if (!changed.length)
			throw new Response("Account changed. Try again.", { status: 409 });
		return json({
			secret,
			otpauthUrl,
			qrSvg: await QRCode.toString(otpauthUrl, {
				type: "svg",
				margin: 1,
				errorCorrectionLevel: "M",
			}),
		});
	}
	if (path === "/api/settings/mfa/confirm") {
		const { code } = z.object({ code: z.string().min(1).max(64) }).parse(data);
		if (!row.totp_secret)
			throw new Response("Start enrolment first", { status: 400 });
		if (row.totp_enabled)
			throw new Response("Two-factor authentication is already on", {
				status: 400,
			});
		if (!(await verifyTotp(row.totp_secret, code)))
			throw new Response(
				"That code did not match. Check the time on your device and try again.",
				{ status: 400 },
			);
		const codes = await Promise.all(
			recoveryCodes().map(async (value) => ({
				value,
				digest: await hash(value.replace(/-/g, "")),
			})),
		);
		await withDatabase((sql) =>
			sql.begin(async (tx) => {
				const changed =
					await tx.NativeConfirmMfa`UPDATE users SET totp_enabled=1,totp_confirmed_at=${seconds()} WHERE id=${user.id} AND disabled=0 AND password_hash=${row.password_hash} AND totp_secret=${row.totp_secret} AND totp_enabled=0 RETURNING id`;
				if (!changed.length)
					throw new Response("Account changed. Try again.", { status: 409 });
				await replaceCodes(tx, user.id, codes);
				await tx.NativeRevokeMfaSessions`DELETE FROM sessions WHERE user_id=${user.id} AND token_hash<>${keep}`;
				await tx.NativeClearMfaChallenges`DELETE FROM login_challenges WHERE user_id=${user.id}`;
			}),
		);
		return json({ ok: true, recoveryCodes: codes.map((code) => code.value) });
	}
	if (
		path === "/api/settings/mfa/disable" ||
		path === "/api/settings/mfa/recovery-codes"
	) {
		const input = z
			.object({
				password: z.string().min(1).max(128),
				code: z.string().min(1).max(64).optional(),
			})
			.parse(data);
		if (!(await bcrypt.compare(input.password, row.password_hash)))
			throw new Response("Password is incorrect", { status: 400 });
		if (!row.totp_enabled || !row.totp_secret)
			throw new Response("Two-factor authentication is not on", {
				status: 400,
			});
		if (path.endsWith("/recovery-codes")) {
			const codes = await Promise.all(
				recoveryCodes().map(async (value) => ({
					value,
					digest: await hash(value.replace(/-/g, "")),
				})),
			);
			await withDatabase((sql) =>
				sql.begin(async (tx) => {
					const [current] =
						await tx.NativeRecoveryGuard`SELECT id FROM users WHERE id=${user.id} AND password_hash=${row.password_hash} AND disabled=0 AND totp_enabled=1 AND totp_secret=${row.totp_secret}`;
					if (!current)
						throw new Response("Account changed. Try again.", { status: 409 });
					await replaceCodes(tx, user.id, codes);
				}),
			);
			return json({ recoveryCodes: codes.map((code) => code.value) });
		}
		const totp =
				!!input.code && (await verifyTotp(row.totp_secret, input.code)),
			recovery = await hash(
				(input.code ?? "").toLowerCase().replace(/[^a-z0-9]/g, ""),
			);
		await withDatabase((sql) =>
			sql.begin(async (tx) => {
				if (!totp) {
					const consumed =
						await tx.NativeDisableMfaRecovery`UPDATE mfa_recovery_codes SET used_at=${seconds()} WHERE user_id=${user.id} AND code_hash=${recovery} AND used_at IS NULL RETURNING id`;
					if (!consumed.length)
						throw new Response("That code did not match", { status: 400 });
				}
				const changed =
					await tx.NativeDisableMfa`UPDATE users SET totp_secret=NULL,totp_enabled=0,totp_confirmed_at=NULL WHERE id=${user.id} AND disabled=0 AND password_hash=${row.password_hash} AND totp_enabled=1 AND totp_secret=${row.totp_secret} RETURNING id`;
				if (!changed.length)
					throw new Response("Account changed. Try again.", { status: 409 });
				await tx.NativeClearDisabledRecovery`DELETE FROM mfa_recovery_codes WHERE user_id=${user.id}`;
				await tx.NativeClearDisabledChallenges`DELETE FROM login_challenges WHERE user_id=${user.id}`;
			}),
		);
		return json({ ok: true });
	}
	return null;
}
