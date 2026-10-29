import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import bcrypt from "bcryptjs";
import { fixture, owner, stranger, enableTeamSharing } from "./fixtures";
import { serveV1Api } from "../src/server/api/v1";
import { createManagedKey } from "../src/server/auth/key-management";
import { authenticateApiKey } from "../src/server/auth/api-key";
import { apiKeyPrincipal } from "../src/server/auth/key-principal";
import { createAccount } from "../src/server/admin/accounts";
import { addDomain } from "../src/server/domains/service";
import { saveInstallation } from "../src/server/cloudflare/installation";
import { LocalStorage } from "../src/server/storage";
import { v1Send } from "../src/server/v1/send";
import { readPublicSendBody } from "../src/server/v1/json-body";
import { cloudflareFixture } from "./cloudflare-fixture";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
const request = (path: string, key?: string, method = "GET", body?: unknown) =>
	new Request("https://mail.example.com/api/v1" + path, {
		method,
		headers: {
			...(key ? { Authorization: `Bearer ${key}` } : {}),
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
const api = (path: string, key?: string, method = "GET", body?: unknown) =>
	serveV1Api(request(path, key, method, body));
const admin = (scopes = ["accounts", "mailboxes", "domains", "storage"]) =>
	createManagedKey(owner, "admin", { name: "Automation", scopes });
const personal = (scopes = ["read", "send"], mailboxIds = ["mailbox"]) =>
	createManagedKey(owner, "personal", { name: "Client", scopes, mailboxIds });
const sendInput = {
	from: "hello@example.com",
	to: ["Recipient <recipient@example.org>"],
	mailboxId: "mailbox",
	subject: "API message",
	text: "API body",
};
async function principal(value: string, scope: string) {
	const key = await authenticateApiKey(request("/messages", value));
	if (!key) throw new Error("Missing fixture key");
	return apiKeyPrincipal(key, scope);
}
async function install() {
	await saveInstallation({
		accountId: "a".repeat(32),
		zoneId: "zone",
		hostname: "example.com",
		workerName: "fixture",
		publicOrigin: "https://mail.example.com",
		auth: { kind: "token" as const, token: "synthetic" },
		relaySecret: "secret",
		relayVersion: "fixture",
	});
}

test("v1 authentication accepts only Bearer keys and isolates mail and administrative scopes", async () => {
	const read = await personal(["read"]),
		manage = await admin();
	expect((await api("/messages")).status).toBe(401);
	expect(
		(
			await serveV1Api(
				new Request("https://mail.example.com/api/v1/messages", {
					headers: { Authorization: "Basic " + btoa("ignored:" + read.key) },
				}),
			)
		).status,
	).toBe(401);
	expect((await api("/accounts", read.key)).status).toBe(401);
	expect((await api("/messages", manage.key)).status).toBe(401);
	expect((await api("/send", read.key, "POST", sendInput)).status).toBe(401);
	state.db.exec("UPDATE users SET role='user' WHERE id='owner'");
	expect((await api("/storage", manage.key)).status).toBe(401);
	state.db.exec("UPDATE users SET disabled=1 WHERE id='owner'");
	expect((await api("/messages", read.key)).status).toBe(401);
});
test("mail keys filter granted mailboxes before pagination and return source rows without native internal fields", async () => {
	enableTeamSharing(state.db);
	state.db.exec(
		"INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES('shared','mailbox','stranger','read_only',1); INSERT INTO mailboxes(id,user_id,domain_id,local_part,created_at) VALUES('second','owner','domain','second',1); INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,text_body,status,created_at) VALUES('outside','owner','second','inbound','outside@example.org','second@example.com','Outside','Outside body','received',2),('private','stranger','mailbox','outbound','hello@example.com','private@example.net','Private draft','Secret draft body','draft',3),('template','owner','mailbox','outbound','hello@example.com','a@example.org','Template','Template body','template',4)",
	);
	const key = await personal(["read"]);
	const response = await api("/messages", key.key),
		data = await response.json();
	expect(response.status).toBe(200);
	expect(data.messages.map((row: { id: string }) => row.id).sort()).toEqual([
		"message",
		"template",
	]);
	expect(
		data.messages.find((row: { id: string }) => row.id === "message"),
	).toMatchObject({
		textBody: "Welcome to Mailrun",
		htmlBody: null,
		rawR2Key: null,
		read: false,
		createdAt: "1970-01-01T00:00:01.000Z",
	});
	expect(JSON.stringify(data)).not.toContain("draft_revision");
	expect(JSON.stringify(data)).not.toContain("Secret draft body");
	expect((await api("/messages?mailboxId=second", key.key)).status).toBe(404);
	expect(
		(await api("/messages?mailboxId=second&limit=0", key.key)).status,
	).toBe(404);
	expect(
		(
			await (await api("/messages?q=subject:searchable", key.key)).json()
		).messages.map((row: { id: string }) => row.id),
	).toEqual(["message"]);
	expect(
		(await (await api("/messages?limit=0", key.key)).json()).messages,
	).toEqual([]);
	const empty = await personal(["calendar:read"], []);
	state.db
		.query("UPDATE api_keys SET scopes=? WHERE id=?")
		.run('["read"]', empty.id);
	expect((await (await api("/messages", empty.key)).json()).messages).toEqual(
		[],
	);
});
test("legacy wildcard mail keys work without granting administrative access and HEAD/method contracts are retained", async () => {
	const key = await personal(["read"]);
	state.db
		.query("UPDATE api_keys SET scopes=? WHERE id=?")
		.run('["*"]', key.id);
	expect((await api("/messages", key.key)).status).toBe(200);
	expect((await api("/domains", key.key)).status).toBe(401);
	const head = await api("/messages", key.key, "HEAD");
	expect(head.status).toBe(200);
	expect(await head.text()).toBe("");
	const unsupported = await api("/messages", key.key, "DELETE");
	expect(unsupported.status).toBe(405);
	expect(unsupported.headers.get("allow")).toContain("HEAD");
});
test("administrative account keys see only the caller and accounts they created", async () => {
	enableTeamSharing(state.db);
	state.db.exec(
		"UPDATE users SET created_by_user_id='owner' WHERE id='stranger'; INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES('unrelated','unrelated@example.net','Unrelated','test','user',1)",
	);
	const key = await admin(["accounts"]);
	const listed = await (await api("/accounts", key.key)).json();
	expect(listed.accounts.map((row: { id: string }) => row.id).sort()).toEqual([
		"owner",
		"stranger",
	]);
	expect((await api("/accounts/unrelated", key.key)).status).toBe(404);
	const details = await (await api("/accounts/stranger", key.key)).json();
	expect(details.account).toMatchObject({
		id: "stranger",
		email: "stranger@example.com",
		hasAvatar: false,
	});
	expect(JSON.stringify(details)).not.toContain("password_hash");
});
test("legacy delegated administrative keys retain scoped powers without gaining UI administration permissions", async () => {
	enableTeamSharing(state.db);
	state.db.exec(
		"UPDATE users SET role='admin' WHERE id='stranger'; INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('delegate-domain','stranger','delegated.example.org','manual','active',1)",
	);
	const key = await admin(["accounts"]);
	state.db
		.query("UPDATE api_keys SET user_id=? WHERE id=?")
		.run("stranger", key.id);
	const input = {
		username: "child",
		domainId: "delegate-domain",
		password: "synthetic-password",
		role: "user",
	};
	await expect(
		createAccount({ ...stranger, role: "admin" }, input),
	).rejects.toMatchObject({ status: 403 });
	const created = await api("/accounts", key.key, "POST", input),
		data = await created.json();
	expect(created.status).toBe(201);
	expect(data.account.email).toBe("child@delegated.example.org");
	const update = {
		name: "Updated child",
		role: "user",
		disabled: false,
		canManageMailboxes: false,
	};
	expect(
		(await api("/accounts/" + data.account.id, key.key, "PATCH", update))
			.status,
	).toBe(200);
	expect(
		(
			await api("/accounts", key.key, "POST", {
				...input,
				username: "bad-admin",
				role: "admin",
			})
		).status,
	).toBe(403);
	expect(
		(
			await api("/accounts/owner", key.key, "PATCH", {
				...update,
				role: "admin",
			})
		).status,
	).toBe(404);
});
test("revoking account scope during password hashing rolls back account creation", async () => {
	enableTeamSharing(state.db);
	const key = await admin(["accounts"]),
		actor = await principal(key.key, "accounts"),
		original = bcrypt.hash;
	const mock = spyOn(bcrypt, "hash").mockImplementation(async (value, salt) => {
		state.db.query("UPDATE api_keys SET scopes=? WHERE id=?").run("[]", key.id);
		return original(value, salt);
	});
	try {
		await expect(
			createAccount(actor, {
				username: "revoked",
				domainId: "domain",
				password: "synthetic-password",
				role: "user",
			}),
		).rejects.toMatchObject({ status: 401 });
		expect(
			state.db
				.query("SELECT id FROM users WHERE email='revoked@example.com'")
				.all(),
		).toEqual([]);
	} finally {
		mock.mockRestore();
	}
});
test("account license gates and primary protection match the public contract", async () => {
	const key = await admin(["accounts"]);
	expect((await api("/accounts", key.key)).status).toBe(403);
	enableTeamSharing(state.db);
	const updated = await api("/accounts/owner", key.key, "PATCH", {
		name: "Owner",
		role: "user",
		disabled: true,
		canManageMailboxes: false,
	});
	expect(updated.status).toBe(200);
	expect(
		state.db.query("SELECT role,disabled FROM users WHERE id='owner'").get(),
	).toEqual({ role: "admin", disabled: 0 });
});
test("mailbox administration follows creator scope without granting access to child messages", async () => {
	const key = await admin(["mailboxes"]);
	state.db.exec(
		"UPDATE users SET created_by_user_id='owner' WHERE id='stranger'; INSERT INTO mailboxes(id,user_id,domain_id,local_part,created_at) VALUES('child-box','stranger','domain','child',1); INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES('other','other@example.net','Other','test','user',1); INSERT INTO mailboxes(id,user_id,domain_id,local_part,created_at) VALUES('foreign-box','other','domain','foreign',1)",
	);
	const list = await (await api("/mailboxes", key.key)).json();
	expect(list.mailboxes.map((row: { id: string }) => row.id).sort()).toEqual([
		"child-box",
		"mailbox",
	]);
	expect((await api("/mailboxes/foreign-box", key.key)).status).toBe(404);
	expect(
		(
			await api("/mailboxes/child-box", key.key, "PATCH", {
				displayName: "Child inbox",
				signature: " Regards ",
				autoReplyEnabled: true,
				autoReplySubject: "",
			})
		).status,
	).toBe(200);
	expect(
		state.db
			.query(
				"SELECT display_name,signature,auto_reply_subject FROM mailboxes WHERE id='child-box'",
			)
			.get(),
	).toEqual({
		display_name: "Child inbox",
		signature: "Regards",
		auto_reply_subject: "Out of office",
	});
	const created = await api("/mailboxes", key.key, "POST", {
		domainId: "domain",
		ownerUserId: "stranger",
		localPart: "new-child",
	});
	expect(created.status).toBe(201);
	expect(
		(
			await api("/mailboxes", key.key, "POST", {
				domainId: "domain",
				localPart: "new-child",
			})
		).status,
	).toBe(409);
	expect(
		(
			await api("/mailboxes", key.key, "POST", {
				domainId: "domain",
				localPart: "shared",
				type: "shared",
			})
		).status,
	).toBe(403);
	expect((await api("/mailboxes/child-box", key.key, "DELETE")).status).toBe(
		200,
	);
	expect((await api("/mailboxes/child-box", key.key)).status).toBe(404);
});
test("local storage status and health checks report files and clean their test objects", async () => {
	const key = await admin(["storage"]),
		status = await (await api("/storage", key.key)).json();
	expect(status).toEqual({
		storage: {
			provider: "files",
			configured: true,
			bucket: null,
			endpoint: null,
		},
		warning: null,
	});
	const tested = await api("/storage", key.key, "POST");
	expect(tested.status).toBe(200);
	expect(await tested.json()).toMatchObject({ ok: true });
	expect(
		await Array.fromAsync(
			new Bun.Glob("healthcheck/*").scan({ cwd: new LocalStorage().root }),
		),
	).toEqual([]);
	const mock = spyOn(LocalStorage.prototype, "put").mockRejectedValue(
		new Error("Disk full"),
	);
	try {
		const failed = await api("/storage", key.key, "POST");
		expect(failed.status).toBe(502);
		expect(await failed.json()).toMatchObject({
			ok: false,
			error: "Disk full",
		});
	} finally {
		mock.mockRestore();
	}
});
test("storage health reports deletion failures instead of claiming a successful round trip", async () => {
	const key = await admin(["storage"]),
		mock = spyOn(LocalStorage.prototype, "delete").mockRejectedValue(
			new Error("Cleanup failed"),
		);
	try {
		const result = await api("/storage", key.key, "POST");
		expect(result.status).toBe(502);
		expect(await result.json()).toMatchObject({
			ok: false,
			error: "Cleanup failed",
		});
	} finally {
		mock.mockRestore();
	}
});
test("public sends preserve headers, recipients and attachments and use the native delivery service", async () => {
	await install();
	const key = await personal(["send"]),
		seen: unknown[] = [];
	const sent = await serveV1Api(
		request("/send", key.key, "POST", {
			...sendInput,
			cc: "copy@example.org",
			bcc: "hidden@example.org",
			inReplyTo: "<parent@example.org>",
			references: ["<root@example.org>", "<parent@example.org>"],
			attachments: [
				{
					filename: "note.txt",
					type: "text/plain",
					contentBase64: btoa("API attachment"),
				},
			],
		}),
		async (_, init) => {
			seen.push(JSON.parse(String(init?.body)));
			return Response.json({
				success: true,
				result: { message_id: "api-provider-id" },
			});
		},
	);
	expect(sent.status).toBe(200);
	const data = await sent.json();
	expect(data.messageId).toBeString();
	expect(data.scheduled).toBeUndefined();
	expect(seen[0]).toMatchObject({
		to: sendInput.to,
		cc: ["copy@example.org"],
		bcc: ["hidden@example.org"],
		headers: { "In-Reply-To": "<parent@example.org>" },
		attachments: [{ filename: "note.txt", content: btoa("API attachment") }],
	});
	expect(
		state.db
			.query("SELECT status,read FROM messages WHERE id=?")
			.get(data.messageId),
	).toEqual({ status: "sent", read: 1 });
});
test("subject-only and scheduled API sends retain the source behavior", async () => {
	const key = await personal(["send"]),
		actor = await principal(key.key, "send");
	const scheduled = await v1Send(actor, {
		...sendInput,
		text: undefined,
		scheduledAt: "2099-01-01T00:00:00Z",
	});
	expect(scheduled).toMatchObject({ scheduled: true });
	expect(
		state.db
			.query("SELECT status,text_body FROM messages WHERE id=?")
			.get(scheduled.messageId),
	).toEqual({ status: "queued", text_body: null });
	expect(
		state.db
			.query("SELECT email FROM contacts WHERE email='recipient@example.org'")
			.all(),
	).toHaveLength(1);
	await install();
	let posted = false;
	const onlySubject = await v1Send(
		actor,
		{ ...sendInput, text: undefined },
		async () => {
			posted = true;
			return Response.json({
				success: true,
				result: { message_id: "empty-body" },
			});
		},
	);
	expect(posted).toBe(true);
	expect(onlySubject).not.toHaveProperty("scheduled");
});
test("send failures remain failed messages, and attachment publication failure leaves no partial outbox", async () => {
	const key = await personal(["send"]),
		actor = await principal(key.key, "send");
	await install();
	const failed = await serveV1Api(
		request("/send", key.key, "POST", sendInput),
		async () =>
			Response.json(
				{ success: false, errors: [{ message: "Provider unavailable" }] },
				{ status: 503 },
			),
	);
	expect(failed.status).toBe(500);
	expect(
		state.db
			.query("SELECT status FROM messages WHERE subject='API message'")
			.get(),
	).toEqual({ status: "failed" });
	const count = state.db
		.query<{ total: number }, []>("SELECT count(*) AS total FROM messages")
		.get()!.total;
	const mock = spyOn(LocalStorage.prototype, "put").mockRejectedValue(
		new Error("Disk full"),
	);
	try {
		await expect(
			v1Send(actor, {
				...sendInput,
				attachments: [{ filename: "note.txt", contentBase64: btoa("hello") }],
			}),
		).rejects.toThrow("Disk full");
		expect(
			state.db.query("SELECT count(*) AS total FROM messages").get(),
		).toEqual({ total: count });
	} finally {
		mock.mockRestore();
	}
});
test("send keys cannot cross mailbox grants, sender aliases or current key permissions", async () => {
	const key = await personal(["send"]);
	state.db.exec(
		"INSERT INTO mailboxes(id,user_id,domain_id,local_part,created_at) VALUES('second','owner','domain','second',1)",
	);
	expect(
		(
			await api("/send", key.key, "POST", {
				...sendInput,
				mailboxId: "second",
				from: "second@example.com",
			})
		).status,
	).toBe(404);
	expect(
		(
			await api("/send", key.key, "POST", {
				...sendInput,
				from: "other@example.com",
			})
		).status,
	).toBe(403);
	const actor = await principal(key.key, "send");
	state.db
		.query("UPDATE api_keys SET scopes=? WHERE id=?")
		.run('["domains","*"]', key.id);
	await expect(v1Send(actor, sendInput)).rejects.toMatchObject({ status: 401 });
	expect(
		state.db.query("SELECT id FROM messages WHERE subject='API message'").all(),
	).toEqual([]);
});
test("public domain keys retain DNS controls even when UI management flags are absent", async () => {
	const key = await admin(["domains"]),
		cloud = cloudflareFixture();
	state.db.exec(
		"UPDATE users SET is_primary_admin=0,can_manage_domains=0 WHERE id='owner'",
	);
	const call = (path: string, method = "GET", body?: unknown) =>
		serveV1Api(request(path, key.key, method, body), cloud.fetch, {
			domainClient: cloud.client,
			lookup: cloud.lookup,
		});
	const listed = await (await call("/domains")).json();
	expect(listed.domains[0].id).toBe("domain");
	expect(listed.dns).toBeDefined();
	expect(
		(await call("/domains/domain/dns/setup", "POST", { record: "dmarc" }))
			.status,
	).toBe(200);
	expect(
		cloud.records.some((record) => record.name === "_dmarc.example.com"),
	).toBe(true);
	const input = {
		hostname: "new.example.com",
		enableRouting: false,
		enableSending: false,
		receivingProvider: "none",
		sendingProvider: "none",
	};
	await expect(
		addDomain(owner, input, cloud.client, cloud.lookup),
	).rejects.toMatchObject({ status: 403 });
	const added = await call("/domains", "POST", input),
		data = await added.json();
	expect(added.status).toBe(200);
	expect(data.domain.hostname).toBe("new.example.com");
	expect((await call("/domains/" + data.domain.id, "DELETE")).status).toBe(200);
	expect((await call("/domains/missing")).status).toBe(404);
});

test("send scope still requires sending rights on a shared mailbox", async () => {
	enableTeamSharing(state.db);
	state.db.exec(
		"INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES('read-only','mailbox','stranger','read_only',1)",
	);
	const key = await createManagedKey(stranger, "personal", {
		name: "Read-only mailbox",
		scopes: ["send"],
		mailboxIds: ["mailbox"],
	});
	const sent = await api("/send", key.key, "POST", sendInput);
	expect(sent.status).toBe(403);
	expect(
		state.db.query("SELECT id FROM messages WHERE direction='outbound'").all(),
	).toEqual([]);
});
test("public send keeps the two-megabyte body contract but rejects an oversized Cloudflare wire request", async () => {
	await install();
	const key = await personal(["send"]);
	let called = false;
	const accepted = await serveV1Api(
		request("/send", key.key, "POST", {
			...sendInput,
			text: "A".repeat(1_100_000),
		}),
		async () => {
			called = true;
			return Response.json({
				success: true,
				result: { message_id: "larger-than-draft-limit" },
			});
		},
	);
	expect(accepted.status).toBe(200);
	expect(called).toBe(true);
	called = false;
	const rejected = await serveV1Api(
		request("/send", key.key, "POST", {
			...sendInput,
			text: "😀".repeat(1_000_000),
			html: "B".repeat(2_000_000),
		}),
		async () => {
			called = true;
			return Response.json({
				success: true,
				result: { message_id: "should-not-send" },
			});
		},
	);
	expect(rejected.status).toBe(400);
	expect(called).toBe(false);
	expect(await rejected.json()).toMatchObject({
		error: expect.stringContaining("5 MiB"),
	});
});

test("chunked public JSON uses private staging and removes both successful and malformed bodies", async () => {
	const content = new TextEncoder().encode(
		JSON.stringify({ text: "x".repeat(600_000) }),
	);
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (let i = 0; i < content.length; i += 8192)
				controller.enqueue(content.subarray(i, i + 8192));
			controller.close();
		},
	});
	expect(
		await readPublicSendBody(
			new Request("http://localhost/send", { method: "POST", body }),
		),
	).toEqual({ text: "x".repeat(600_000) });
	await expect(
		readPublicSendBody(
			new Request("http://localhost/send", {
				method: "POST",
				body: "not JSON",
			}),
		),
	).rejects.toBeInstanceOf(SyntaxError);
	expect(
		await Array.fromAsync(
			new Bun.Glob("import-staging/*.json").scan({
				cwd: new LocalStorage().root,
			}),
		),
	).toEqual([]);
});
test("chunked public JSON enforces the original 40 MiB limit while cancelling oversized input", async () => {
	let cancelled = false,
		parts = 0;
	const chunk = new Uint8Array(1024 * 1024);
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (parts++ < 42) controller.enqueue(chunk);
			else controller.close();
		},
		cancel() {
			cancelled = true;
		},
	});
	await expect(
		readPublicSendBody(
			new Request("http://localhost/send", { method: "POST", body }),
		),
	).rejects.toThrow("Message too large");
	expect(cancelled).toBe(true);
	expect(
		await Array.fromAsync(
			new Bun.Glob("import-staging/*.json").scan({
				cwd: new LocalStorage().root,
			}),
		),
	).toEqual([]);
});
