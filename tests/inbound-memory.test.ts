import { expect, test, spyOn } from "bun:test";
import { fixture } from "./fixtures";
import { verifyInboundSignature } from "../src/server/mail/relay-auth";
import { signRelay } from "../src/shared/relay-signature";
import { parseMail } from "../src/server/mail/parse";
import { serveInbound } from "../src/server/mail/inbound";
import { LocalStorage } from "../src/server/storage";
test("native incremental HMAC retains Worker signature, forwarding phases and rejection boundaries", async () => {
	const now = Date.now(),
		timestamp = String(now),
		secret = "synthetic-key",
		body = new TextEncoder().encode("Hello \u2709\ufe0f"),
		to = "hello@example.com";
	for (const phase of ["", "forwarded\n", "forward-failed\n"]) {
		const from = phase + "sender@example.org",
			signature = await signRelay(secret, timestamp, from, to, body);
		expect(
			verifyInboundSignature(secret, timestamp, from, to, body, signature, now),
		).toBe(true);
		expect(
			verifyInboundSignature(
				secret,
				timestamp,
				from,
				to,
				new Uint8Array([0]),
				signature,
				now,
			),
		).toBe(false);
		expect(
			verifyInboundSignature(
				secret,
				timestamp,
				from,
				to,
				body,
				signature,
				now + 300_001,
			),
		).toBe(false);
		expect(
			verifyInboundSignature(
				secret,
				timestamp,
				from,
				to,
				body,
				signature.toUpperCase(),
				now,
			),
		).toBe(false);
	}
});
test("MIME parsing retains exact view bounds while reusing complete input buffers", async () => {
	const raw = new TextEncoder().encode(
			"From: sender@example.org\r\nTo: hello@example.com\r\nSubject: Exact input\r\n\r\nBody.",
		),
		wrapped = new Uint8Array(raw.length + 16);
	wrapped.fill(65);
	wrapped.set(raw, 8);
	const direct = await parseMail(raw),
		view = await parseMail(wrapped.subarray(8, 8 + raw.length));
	expect(view).toEqual(direct);
	expect(view.subject).toBe("Exact input");
	expect(view.text?.trim()).toBe("Body.");
	expect(new TextDecoder().decode(raw)).toContain("Subject: Exact input");
});
test("native signed ingress returns a retryable failure without acknowledging or committing a failed writeback", async () => {
	const state = await fixture(),
		secret = "synthetic-signing-key",
		timestamp = String(Date.now()),
		raw = new TextEncoder().encode(
			"From: sender@example.org\r\nTo: hello@example.com\r\nSubject: Never acknowledged\r\n\r\nBody.",
		);
	state.db
		.query(
			"INSERT INTO mailrun_installation(id,account_id,zone_id,hostname,worker_name,public_origin,api_token,relay_secret,relay_version,phase,updated_at) VALUES('primary',?,'zone','example.com','fixture-relay','https://example.test','synthetic-token',?,'fixture','ready',1)",
		)
		.run("a".repeat(32), secret);
	const mock = spyOn(LocalStorage.prototype, "syncFile").mockRejectedValue(
		Object.assign(new Error("private writeback failure"), { code: "EIO" }),
	);
	try {
		const result = await serveInbound(
			new Request("https://example.test/api/inbound", {
				method: "POST",
				headers: {
					"X-Mailrun-Timestamp": timestamp,
					"X-Mailrun-Signature": await signRelay(
						secret,
						timestamp,
						"sender@example.org",
						"hello@example.com",
						raw,
					),
					"X-Mailrun-From": "sender@example.org",
					"X-Mailrun-To": "hello@example.com",
					"X-Mailrun-Relay": "2",
				},
				body: raw,
			}),
		);
		expect(result.status).toBe(503);
		expect(result.headers.get("Cache-Control")).toBe("private, no-store");
		expect(await result.text()).toBe("Email storage temporarily unavailable");
		expect(
			state.db
				.query("SELECT id FROM messages WHERE subject='Never acknowledged'")
				.all(),
		).toHaveLength(0);
	} finally {
		mock.mockRestore();
		await state.close();
	}
});
