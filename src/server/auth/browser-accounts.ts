import { z } from "zod";
import {
	getCookie,
	setCookie,
	deleteCookie,
} from "@tanstack/react-start/server";
import { withDatabase, id, seconds } from "../db";
import { publicOrigin } from "../config";
import {
	hash,
	getUser,
	logout,
	SESSION_COOKIE,
	SESSION_SECONDS,
	rateLimit,
} from "./service";
import { verifyTotp } from "./totp";
const ACCOUNTS_COOKIE = "ep_accounts";
export function accountTokens(value: string | undefined) {
	return [
		...new Set(
			(value ?? "")
				.split(".")
				.filter((token) => token.length > 0 && token.length <= 256),
		),
	].slice(0, 5);
}
const options = () => ({
	httpOnly: true,
	secure: publicOrigin().startsWith("https:"),
	sameSite: "lax" as const,
	path: "/",
	maxAge: SESSION_SECONDS,
});
export async function resolveBrowserAccounts(tokens: string[]) {
	const pairs = await Promise.all(
		[...new Set(tokens)].map(async (token) => ({
			token,
			digest: await hash(token),
		})),
	);
	if (!pairs.length) return [];
	const rows = await withDatabase(
		(sql) => sql.BrowserAccountUsers`
 /* @notNull id */
 SELECT u.id,u.email,u.name,u.avatar_key,s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash IN (SELECT value FROM json_each(${JSON.stringify(pairs.map((pair) => pair.digest))})) AND s.expires_at>${seconds()} AND u.disabled=0`,
	);
	const map = new Map(rows.map((row) => [row.token_hash, row]));
	return pairs.flatMap((pair) => {
		const row = map.get(pair.digest);
		return row
			? [
					{
						userId: row.id,
						email: row.email,
						name: row.name,
						hasAvatar: !!row.avatar_key,
						avatarKey: row.avatar_key,
						token: pair.token,
					},
				]
			: [];
	});
}
export async function rememberBrowserLogin(token: string) {
	const existing = await resolveBrowserAccounts([
		...accountTokens(getCookie(ACCOUNTS_COOKIE)),
		...(getCookie(SESSION_COOKIE) ? [getCookie(SESSION_COOKIE) ?? ""] : []),
	]);
	const user = await getUser(token);
	if (!user) throw new Error("Session was not created");
	setCookie(
		ACCOUNTS_COOKIE,
		[
			...existing
				.filter((account) => account.userId !== user.id)
				.map((account) => account.token),
			token,
		]
			.slice(-5)
			.join("."),
		options(),
	);
	setCookie(SESSION_COOKIE, token, options());
}
export async function browserAccounts() {
	const active = getCookie(SESSION_COOKIE);
	const accounts = await resolveBrowserAccounts([
		...accountTokens(getCookie(ACCOUNTS_COOKIE)),
		...(active ? [active] : []),
	]);
	return accounts.map(({ token, avatarKey, ...account }) => ({
		...account,
		active: token === active,
	}));
}
export async function switchBrowserAccount(userId: string) {
	const active = getCookie(SESSION_COOKIE),
		accounts = await resolveBrowserAccounts([
			...accountTokens(getCookie(ACCOUNTS_COOKIE)),
			...(active ? [active] : []),
		]);
	const target = accounts.find((account) => account.userId === userId);
	if (!target)
		throw new Response("Account is not signed in on this browser", {
			status: 401,
		});
	setCookie(SESSION_COOKIE, target.token, options());
	return { ok: true, token: target.token };
}
export async function logoutBrowserAccount(token?: string) {
	const active = token ?? getCookie(SESSION_COOKIE);
	await logout(active);
	const remaining = await resolveBrowserAccounts(
		accountTokens(getCookie(ACCOUNTS_COOKIE)).filter(
			(token) => token !== active,
		),
	);
	const target = remaining[remaining.length - 1];
	if (target) setCookie(SESSION_COOKIE, target.token, options());
	else deleteCookie(SESSION_COOKIE, { path: "/" });
	if (remaining.length)
		setCookie(
			ACCOUNTS_COOKIE,
			remaining.map((account) => account.token).join("."),
			options(),
		);
	else deleteCookie(ACCOUNTS_COOKIE, { path: "/" });
	return { ok: true, ...(target ? { token: target.token } : {}) };
}
export async function issueLoginChallenge(email: string) {
	const [user] = await withDatabase(
		(sql) =>
			sql.ChallengeAccount`SELECT id FROM users WHERE email=${email.toLowerCase()} AND disabled=0 AND totp_enabled=1`,
	);
	if (!user) throw new Response("Invalid credentials", { status: 401 });
	const token = id("mfa"),
		digest = await hash(token);
	await withDatabase(
		(sql) =>
			sql.SourceLoginChallenge`INSERT INTO login_challenges (id,user_id,token_hash,expires_at,created_at) VALUES (${id()},${user.id},${digest},${seconds() + 300},${seconds()})`,
	);
	return token;
}
export async function verifyLoginChallenge(
	challengeToken: string,
	code: string,
) {
	rateLimit(`mfa:${challengeToken}`);
	const digest = await hash(challengeToken);
	const [account] = await withDatabase(
		(sql) => sql.SourceMfaAccount`
 /* @notNull id */
 SELECT u.id,u.totp_secret FROM login_challenges c JOIN users u ON u.id=c.user_id WHERE c.token_hash=${digest} AND c.expires_at>${seconds()} AND u.disabled=0 AND u.totp_enabled=1`,
	);
	if (!account)
		throw new Response("This sign-in attempt has expired. Start again.", {
			status: 401,
		});
	const totp =
		!!account.totp_secret && (await verifyTotp(account.totp_secret, code));
	const recovery = await hash(code.toLowerCase().replace(/[^a-z0-9]/g, ""));
	const token = id("sess"),
		sessionHash = await hash(token);
	await withDatabase((sql) =>
		sql.begin(async (sql) => {
			const claimed =
				await sql.SourceConsumeChallenge`DELETE FROM login_challenges WHERE token_hash=${digest} AND expires_at>${seconds()} AND EXISTS(SELECT 1 FROM users WHERE id=${account.id} AND disabled=0 AND totp_enabled=1 AND totp_secret IS ${account.totp_secret}) RETURNING id`;
			if (!claimed.length)
				throw new Response("This sign-in attempt has expired. Start again.", {
					status: 401,
				});
			if (!totp) {
				const consumed =
					await sql.SourceMfaRecovery`UPDATE mfa_recovery_codes SET used_at=${seconds()} WHERE user_id=${account.id} AND code_hash=${recovery} AND used_at IS NULL RETURNING id`;
				if (!consumed.length)
					throw new Response("That code did not match", { status: 401 });
			}
			await sql.SourceMfaSession`INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (${id()},${account.id},${sessionHash},${seconds() + SESSION_SECONDS},${seconds()})`;
		}),
	);
	return { token, method: totp ? "totp" : "recovery" };
}
