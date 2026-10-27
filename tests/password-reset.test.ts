import { test, expect, beforeEach, afterEach } from "bun:test";
import bcrypt from "bcryptjs";
import { fixture, owner } from "./fixtures";
import {
	requestPasswordReset,
	completePasswordReset,
} from "../src/server/auth/password-reset";
import { sendSystemMail, type SystemMail } from "../src/server/mail/system";
import { createSession, getUser } from "../src/server/auth/service";
import { saveInstallation } from "../src/server/cloudflare/installation";
import { publicAuthGuard } from "../src/server/auth/public-guard";
import { apiErrorResponse } from "../src/server/api/errors";
let state: Awaited<ReturnType<typeof fixture>>, secret: string | undefined;
beforeEach(async () => {
	state = await fixture();
	secret = process.env.TURNSTILE_SECRET_KEY;
	delete process.env.TURNSTILE_SECRET_KEY;
	globalThis.__mailrunPublicAuthAttempts?.clear();
});
afterEach(async () => {
	if (secret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
	else process.env.TURNSTILE_SECRET_KEY = secret;
	await state.close();
});
async function resetToken() {
	state.db.exec(
		"UPDATE users SET reset_email='recovery@example.net' WHERE id='owner'",
	);
	let mail: SystemMail | null = null;
	await requestPasswordReset(
		owner.email,
		"https://fixture.example",
		async (value) => {
			mail = value;
			return true;
		},
	);
	if (!mail) throw new Error("No reset mail");
	const sent = mail as SystemMail,
		url = sent.text
			.split("\n")
			.find((line) =>
				line.startsWith("https://fixture.example/reset-password?"),
			);
	if (!url) throw new Error("No reset URL");
	return { token: new URL(url).searchParams.get("token")!, mail: sent };
}
test("recovery links last thirty minutes, reveal no stored plaintext token and use the source email content", async () => {
	const { token, mail } = await resetToken();
	expect(mail.to).toBe("recovery@example.net");
	expect(mail.subject).toBe("Reset your Mailflare password");
	expect(mail.html).toContain("within 30 minutes");
	const stored = state.db
		.query<{ token_hash: string; created_at: number; expires_at: number }, []>(
			"SELECT token_hash,created_at,expires_at FROM password_reset_tokens",
		)
		.get()!;
	expect(stored.token_hash).not.toContain(token);
	expect(stored.expires_at - stored.created_at).toBe(1800);
	expect(
		state.db.query("SELECT count(*) AS n FROM outbound_jobs").get(),
	).toEqual({ n: 0 });
});
test("unknown, disabled and accounts without recovery addresses produce no mail or token", async () => {
	let count = 0;
	const send = async () => {
		count++;
		return true;
	};
	await requestPasswordReset(
		"absent@example.com",
		"https://fixture.example",
		send,
	);
	await requestPasswordReset(owner.email, "https://fixture.example", send);
	state.db.exec(
		"UPDATE users SET reset_email='recovery@example.net',disabled=1 WHERE id='owner'",
	);
	await requestPasswordReset(owner.email, "https://fixture.example", send);
	expect(count).toBe(0);
	expect(
		state.db.query("SELECT count(*) AS n FROM password_reset_tokens").get(),
	).toEqual({ n: 0 });
});
test("reset redemption is atomic, single-use and revokes sessions plus old MFA challenges", async () => {
	const { token } = await resetToken(),
		session = await createSession(owner.id);
	state.db.exec(
		"INSERT INTO login_challenges(id,user_id,token_hash,expires_at,created_at) VALUES ('challenge','owner','challenge-hash',9999999999,1)",
	);
	const results = await Promise.all([
		completePasswordReset(
			token,
			"new password one",
			new Request("http://localhost"),
		),
		completePasswordReset(
			token,
			"new password two",
			new Request("http://localhost"),
		),
	]);
	expect(results.filter((result) => result.ok)).toHaveLength(1);
	expect(await getUser(session)).toBeNull();
	expect(
		state.db.query("SELECT count(*) AS n FROM login_challenges").get(),
	).toEqual({ n: 0 });
	const row = state.db
		.query<{ password_hash: string }, []>(
			"SELECT password_hash FROM users WHERE id='owner'",
		)
		.get()!;
	expect(
		await bcrypt.compare(
			"new password " + (results[0]!.ok ? "one" : "two"),
			row.password_hash,
		),
	).toBe(true);
	expect(
		(
			await completePasswordReset(
				token,
				"another password",
				new Request("http://localhost"),
			)
		).ok,
	).toBe(false);
});
test("expired links cannot change a password", async () => {
	const { token } = await resetToken();
	state.db.exec("UPDATE password_reset_tokens SET expires_at=1");
	expect(
		(
			await completePasswordReset(
				token,
				"new password",
				new Request("http://localhost"),
			)
		).ok,
	).toBe(false);
});
test("system recovery mail uses Cloudflare without creating Sent copies or contacts", async () => {
	await saveInstallation({
		accountId: "account",
		zoneId: "zone",
		hostname: "example.com",
		workerName: "relay",
		publicOrigin: "https://fixture.example",
		apiToken: "fixture-token",
		relaySecret: "fixture-secret",
		relayVersion: "test",
	});
	let body: unknown;
	expect(
		await sendSystemMail(
			{
				to: "recovery@example.net",
				subject: "Test",
				text: "Body",
				html: "<p>Body</p>",
			},
			async (_input, init) => {
				body = JSON.parse(String(init?.body));
				return Response.json({
					success: true,
					result: { message_id: "system" },
				});
			},
		),
	).toBe(true);
	expect(body).toMatchObject({
		to: ["recovery@example.net"],
		headers: {
			"Auto-Submitted": "auto-generated",
			"X-Auto-Response-Suppress": "All",
		},
	});
	expect(state.db.query("SELECT count(*) AS n FROM messages").get()).toEqual({
		n: 1,
	});
	expect(state.db.query("SELECT count(*) AS n FROM contacts").get()).toEqual({
		n: 0,
	});
});
test("public auth rate limits retain Retry-After and configured Turnstile is checked on the server", async () => {
	const req = new Request("http://localhost", {
		headers: { "CF-Connecting-IP": "192.0.2.5" },
	});
	for (let i = 0; i < 20; i++) await publicAuthGuard(req);
	try {
		await publicAuthGuard(req);
		throw new Error("Missing rate limit");
	} catch (error) {
		const response = await apiErrorResponse(error);
		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe("60");
	}
	globalThis.__mailrunPublicAuthAttempts?.clear();
	process.env.TURNSTILE_SECRET_KEY = "test-secret";
	await expect(publicAuthGuard(req, undefined, true)).rejects.toMatchObject({
		status: 400,
	});
	await expect(
		publicAuthGuard(req, "token", true, async () =>
			Response.json({ success: false }),
		),
	).rejects.toMatchObject({ status: 400 });
	await publicAuthGuard(req, "valid", true, async (_url, init) => {
		expect(JSON.parse(String(init?.body))).toMatchObject({
			secret: "test-secret",
			response: "valid",
			remoteip: "192.0.2.5",
		});
		return Response.json({ success: true });
	});
});
