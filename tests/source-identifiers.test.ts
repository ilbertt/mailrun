import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import bcrypt from "bcryptjs";
import { fixture, owner } from "./fixtures";
import { id, withDatabase } from "../src/server/db";
import { identifierShape } from "./identifier-shape";
import capture from "./source-identifiers-contracts.json";
import { createManagedKey } from "../src/server/auth/key-management";
import { createSession, getUser, hash } from "../src/server/auth/service";
import { authenticateApiKey } from "../src/server/auth/api-key";
import { recordAuthActivity } from "../src/server/auth/activity";
import { audit } from "../src/server/mail/message-actions";
import { createFolder } from "../src/server/mail/management";
import { requestPasswordReset } from "../src/server/auth/password-reset";
import type { SystemMail } from "../src/server/mail/system";
import { z } from "zod";
const shape = (prefix: string) => {
	const row = capture.result.prefixed.find((row) => row.input === prefix);
	if (!row) throw new Error("Missing original identifier namespace");
	return row.shape;
};
test("original identifier factory preserves bare, empty-prefix and all source namespaces", () => {
	expect({
		bare: identifierShape(id(), null),
		emptyPrefix: identifierShape(id(""), null),
		prefixed: capture.result.prefixed.map((row) => ({
			input: row.input,
			shape: identifierShape(id(row.input), row.input),
		})),
	}).toEqual({
		bare: capture.result.bare,
		emptyPrefix: capture.result.emptyPrefix,
		prefixed: capture.result.prefixed,
	});
});
describe("original identifier writers", () => {
	let state: Awaited<ReturnType<typeof fixture>>;
	beforeEach(async () => {
		state = await fixture();
	});
	afterEach(async () => {
		await state.close();
	});
	test("managed key identifiers and one-time secret format match the original and authenticate", async () => {
		const key = await createManagedKey(owner, "personal", {
			name: "Client",
			scopes: ["read"],
			mailboxIds: ["mailbox"],
		});
		const record = z
			.object({ key_hash: z.string() })
			.parse(
				state.db.query("SELECT key_hash FROM api_keys WHERE id=?").get(key.id),
			);
		expect(identifierShape(key.id)).toEqual(shape("key"));
		expect({
			shape: identifierShape(key.key),
			prefixLength: key.prefix.length,
			prefixMatches: key.prefix === key.key.slice(0, 12),
			bcryptCost: Number(record.key_hash.split("$")[2]),
			verifies: await bcrypt.compare(key.key, record.key_hash),
		}).toEqual(capture.result.apiKey);
		expect(
			(
				await authenticateApiKey(
					new Request("https://identifier.fixture.example/api/v1/messages", {
						headers: { Authorization: "Bearer " + key.key },
					}),
				)
			)?.id,
		).toBe(key.id);
	});
	test("sessions preserve original token, hash and unprefixed row formats", async () => {
		const token = await createSession(owner.id);
		expect(identifierShape(token)).toEqual(capture.result.session.shape);
		expect(await hash("sess_source_identifier_fixture")).toBe(
			capture.result.session.sampleHash,
		);
		expect((await hash(token)).length).toBe(capture.result.session.hashLength);
		const record = z
			.object({ id: z.string() })
			.parse(state.db.query("SELECT id FROM sessions").get());
		expect(identifierShape(record.id, null)).toEqual(capture.result.bare);
		expect((await getUser(token))?.id).toBe(owner.id);
	});
	test("mail and authentication audit rows use the original audit namespace", async () => {
		await withDatabase((sql) =>
			audit(sql, owner, "mailbox", "message", "email.send", {}),
		);
		await recordAuthActivity(
			"auth.login",
			owner.id,
			new Request("https://identifier.fixture.example/login"),
		);
		const rows = z
			.array(z.object({ id: z.string() }))
			.parse(state.db.query("SELECT id FROM audit_logs ORDER BY rowid").all());
		expect(rows).toHaveLength(2);
		for (const row of rows)
			expect(identifierShape(row.id)).toEqual(shape("aud"));
	});
	test("folder creation uses the original public folder namespace", async () => {
		const created = await createFolder(owner, {
			mailboxId: "mailbox",
			name: "Original format",
		});
		expect(identifierShape(created.id)).toEqual(shape("fld"));
	});
	test("password reset tokens and stored rows retain the original separate formats", async () => {
		state.db.exec(
			"UPDATE users SET reset_email='recovery@example.net' WHERE id='owner'",
		);
		const sent: SystemMail[] = [];
		await requestPasswordReset(
			owner.email,
			"https://identifier.fixture.example",
			async (message) => {
				sent.push(message);
				return true;
			},
		);
		expect(sent).toHaveLength(1);
		const text = sent[0]?.text ?? "",
			link = text.split("\n").find((line) => line.startsWith("https://"));
		if (!link) throw new Error("No synthetic recovery link");
		const token = new URL(link).searchParams.get("token");
		if (!token) throw new Error("No synthetic recovery token");
		expect(identifierShape(token)).toEqual(shape("prt"));
		const record = z
			.object({ id: z.string() })
			.parse(state.db.query("SELECT id FROM password_reset_tokens").get());
		expect(identifierShape(record.id, null)).toEqual(capture.result.bare);
	});
	test("stored UUID identities and older UUID session tokens remain valid alongside new identifiers", async () => {
		const userId = "usr_" + crypto.randomUUID(),
			sessionId = "id_" + crypto.randomUUID(),
			oldToken = "sess_" + crypto.randomUUID();
		state.db
			.query(
				"INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,'legacy@example.com','Legacy','fixture','user',1)",
			)
			.run(userId);
		state.db
			.query(
				"INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,1)",
			)
			.run(
				sessionId,
				userId,
				await hash(oldToken),
				Math.floor(Date.now() / 1000) + 600,
			);
		expect((await getUser(oldToken))?.id).toBe(userId);
		const next = await createSession(userId);
		expect(identifierShape(next)).toEqual(capture.result.session.shape);
		expect((await getUser(next))?.id).toBe(userId);
		expect(
			state.db
				.query("SELECT id FROM users WHERE email='legacy@example.com'")
				.get(),
		).toEqual({ id: userId });
	});
});
