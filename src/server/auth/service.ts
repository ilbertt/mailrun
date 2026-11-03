import bcrypt from "bcryptjs";
import { z } from "zod";
import { withDatabase, id, seconds } from "../db";
import {
	userSchema,
	loginSchema,
	registerSchema,
	type User,
} from "../../shared/contracts";
import { verifyTotp, timingSafeEqual } from "./totp";

export const SESSION_COOKIE = "ep_session";
export const SESSION_SECONDS = 30 * 86400;
export async function hash(value: string) {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
function publicUser(row: {
	id: string;
	email: string;
	name: string;
	role: string;
	is_primary_admin: number;
}): User {
	return userSchema.parse({
		...row,
		isPrimaryAdmin: row.is_primary_admin === 1,
	});
}

const loginAttempts = new Map<string, { attempts: number; until: number }>();
export function rateLimit(email: string) {
	const now = Date.now();
	const previous = loginAttempts.get(email);
	if (previous && previous.until > now && previous.attempts >= 10)
		throw new Error("Too many login attempts. Try again in a minute.");
	if (loginAttempts.size > 10_000)
		for (const [key, entry] of loginAttempts)
			if (entry.until <= now) loginAttempts.delete(key);
	loginAttempts.set(
		email,
		previous && previous.until > now
			? { ...previous, attempts: previous.attempts + 1 }
			: { attempts: 1, until: now + 60_000 },
	);
}
export async function hasUsers() {
	return withDatabase(
		async (sql) =>
			(await sql.HasUsers`SELECT id FROM users LIMIT 1`).length > 0,
	);
}
export async function hasAdminAccount() {
	return withDatabase(
		async (sql) =>
			(
				await sql.NativeHasAdminAccount`SELECT id FROM users WHERE role='admin' LIMIT 1`
			).length > 0,
	);
}
export async function getUser(token: string | undefined): Promise<User | null> {
	if (!token || token.length > 256) return null;
	const digest = await hash(token);
	return withDatabase(async (sql) => {
		const [row] = await sql.SessionUser`
			/* @notNull id */
			SELECT u.id, u.email, u.name, u.role, u.is_primary_admin FROM sessions s
			JOIN users u ON u.id=s.user_id
			WHERE s.token_hash=${digest} AND s.expires_at>${seconds()} AND u.disabled=0 LIMIT 1`;
		return row ? publicUser(row) : null;
	});
}
export async function createSession(userId: string) {
	const token = id("sess");
	const digest = await hash(token);
	await withDatabase(
		(sql) => sql.CreateSession`
		INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at)
		VALUES (${id()},${userId},${digest},${seconds() + SESSION_SECONDS},${seconds()})`,
	);
	return token;
}
export async function login(input: z.infer<typeof loginSchema>) {
	const data = loginSchema.parse(input);
	rateLimit(data.email);
	const row = await withDatabase(
		async (sql) =>
			(
				await sql.LoginUser`
		SELECT id,email,name,role,is_primary_admin,password_hash,disabled,totp_enabled,totp_secret
		FROM users WHERE email=${data.email} LIMIT 1`
			)[0],
	);
	// Always spend a password hash even for unknown accounts.
	const valid = await bcrypt.compare(
		data.password,
		row?.password_hash ??
			"$2b$12$QgkxK7gvHTJ0m2Pzj1DrmeehhdbHDS91JwHQFyPKzKOm4p8hRPZmm",
	);
	if (!row || !valid || row.disabled)
		throw new Error("Invalid email or password");
	if (row.totp_enabled) {
		if (!data.code) return { mfaRequired: true as const };
		const validTotp = row.totp_secret
			? await verifyTotp(row.totp_secret, data.code)
			: false;
		if (!validTotp) {
			const codeHash = await hash(
				data.code.toLowerCase().replace(/[^a-z0-9]/g, ""),
			);
			const consumed = await withDatabase(
				(sql) => sql.ConsumeRecoveryCode`
				UPDATE mfa_recovery_codes SET used_at=${seconds()}
				WHERE user_id=${row.id} AND code_hash=${codeHash} AND used_at IS NULL RETURNING id`,
			);
			if (!consumed.length) throw new Error("Invalid authentication code");
		}
	}
	loginAttempts.delete(data.email);
	return {
		mfaRequired: false as const,
		token: await createSession(row.id),
		user: publicUser(row),
	};
}
export async function claimAdministrator(
	input: z.infer<typeof registerSchema>,
) {
	const data = registerSchema.parse(input);
	const expected = process.env.SETUP_TOKEN;
	if (
		!expected ||
		expected.length < 16 ||
		!timingSafeEqual(expected, data.setupToken)
	)
		throw new Error("Invalid setup token");
	const passwordHash = await bcrypt.hash(data.password, 12);
	const userId = id("usr");
	const rows = await withDatabase(
		(sql) => sql.ClaimInstallation`
		INSERT INTO users (id,email,name,password_hash,role,is_primary_admin,created_at)
		SELECT ${userId},${data.email},${data.name},${passwordHash},'admin',1,${seconds()}
		WHERE NOT EXISTS (SELECT 1 FROM users WHERE role='admin') RETURNING id`,
	);
	if (!rows.length) throw new Error("An administrator already exists");
	return userSchema.parse({
		id: userId,
		email: data.email,
		name: data.name,
		role: "admin",
		isPrimaryAdmin: true,
	});
}
export async function register(input: z.infer<typeof registerSchema>) {
	const user = await claimAdministrator(input);
	return { token: await createSession(user.id), user };
}

export async function logout(token: string | undefined) {
	if (!token) return;
	const digest = await hash(token);
	await withDatabase(
		(sql) => sql.DeleteSession`DELETE FROM sessions WHERE token_hash=${digest}`,
	);
}
