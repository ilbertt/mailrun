import { test, expect } from "bun:test";
import bcrypt from "bcryptjs";
import { fixture } from "./fixtures";
import { getUser, login, logout, register } from "../src/server/auth/service";
import { totp } from "../src/server/auth/totp";

test("password sessions preserve existing hashes, expire on logout and reject disabled accounts", async () => {
	const state = await fixture();
	try {
		state.db.query("UPDATE users SET password_hash=? WHERE id='owner'").run(await bcrypt.hash("correct-password", 4));
		await expect(login({ email: "owner@example.com", password: "incorrect" })).rejects.toThrow("Invalid");
		const result = await login({ email: "owner@example.com", password: "correct-password" });
		if (result.mfaRequired) throw new Error("Unexpected MFA challenge");
		expect((await getUser(result.token))?.id).toBe("owner");
		expect(await getUser("invalid")).toBeNull();
		await logout(result.token);
		expect(await getUser(result.token)).toBeNull();
		state.db.query("UPDATE users SET disabled=1 WHERE id='owner'").run();
		await expect(login({ email: "owner@example.com", password: "correct-password" })).rejects.toThrow("Invalid");
	} finally { await state.close(); }
});
test("existing MFA must be satisfied before a session can be created", async () => {
	const state = await fixture();
	try {
		const secret = "JBSWY3DPEHPK3PXP";
		state.db.query("UPDATE users SET password_hash=?,totp_enabled=1,totp_secret=? WHERE id='owner'").run(await bcrypt.hash("correct-password", 4), secret);
		expect(await login({ email: "owner@example.com", password: "correct-password" })).toEqual({ mfaRequired: true });
		await expect(login({ email: "owner@example.com", password: "correct-password", code: "bad" })).rejects.toThrow("Invalid authentication");
		expect((await login({ email: "owner@example.com", password: "correct-password", code: await totp(secret) })).mfaRequired).toBe(false);
	} finally { await state.close(); }
});
test("first admin claim requires the deployment token and cannot replace an existing owner", async () => {
	const state = await fixture();
	const previous = process.env.SETUP_TOKEN;
	process.env.SETUP_TOKEN = "test-installation-token";
	try {
		await expect(register({ email: "new@example.com", name: "New", password: "long-new-password", setupToken: "wrong-setup-token" })).rejects.toThrow("Invalid setup");
		await expect(register({ email: "new@example.com", name: "New", password: "long-new-password", setupToken: "test-installation-token" })).rejects.toThrow("already exists");
	} finally {
		if (previous === undefined) delete process.env.SETUP_TOKEN; else process.env.SETUP_TOKEN = previous;
		await state.close();
	}
});
test("concurrent first-run requests create exactly one owner", async () => {
	const state = await fixture();
	const previous = process.env.SETUP_TOKEN;
	process.env.SETUP_TOKEN = "test-installation-token";
	try {
		state.db.exec("DELETE FROM users");
		const results = await Promise.allSettled([
			register({ name: "First", email: "first@example.com", password: "long-new-password", setupToken: "test-installation-token" }),
			register({ name: "Second", email: "second@example.com", password: "long-new-password", setupToken: "test-installation-token" }),
		]);
		expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
		expect(state.db.query("SELECT id FROM users WHERE is_primary_admin=1").all()).toHaveLength(1);
		for (const result of results) if (result.status === "fulfilled") expect((await getUser(result.value.token))?.isPrimaryAdmin).toBe(true);
	} finally {
		if (previous === undefined) delete process.env.SETUP_TOKEN; else process.env.SETUP_TOKEN = previous;
		await state.close();
	}
});
