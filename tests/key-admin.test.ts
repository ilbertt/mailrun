import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import bcrypt from "bcryptjs";
import { fixture, owner, stranger, enableTeamSharing } from "./fixtures";
import {
	createManagedKey,
	listManagedKeys,
	revokeManagedKey,
} from "../src/server/auth/key-management";
import { authenticateApiKey } from "../src/server/auth/api-key";
import { adminSettingsApi } from "../src/server/api/admin-settings";
import { recordAuthActivity } from "../src/server/auth/activity";
import {
	attachmentLimit,
	saveDraft,
	uploadAttachments,
} from "../src/server/mail/drafts";
import { startUpload } from "../src/server/drive/uploads";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
const input = (scopes = ["read"], mailboxIds = ["mailbox"]) => ({
	name: "Mail app",
	scopes,
	mailboxIds,
});
const authenticate = (key: string, basic = false) =>
	authenticateApiKey(
		new Request("http://localhost/api/calendar/events", {
			headers: {
				Authorization: basic
					? "Basic " + btoa("ignored:" + key)
					: "Bearer " + key,
			},
		}),
	);
test("personal keys are shown once, hashed, scoped to mailboxes and accepted over Bearer/Basic", async () => {
	const created = await createManagedKey(
		owner,
		"personal",
		input(["read", "calendar:read"]),
	);
	expect(created.key).toStartWith("ep_");
	expect(created.prefix).toBe(created.key.slice(0, 12));
	const listed = await listManagedKeys(owner, "personal");
	expect(listed[0]).toMatchObject({
		id: created.id,
		kind: "legacy",
		mailboxScopeEnabled: true,
		mailboxIds: ["mailbox"],
		lastUsedAt: null,
	});
	expect(JSON.stringify(listed)).not.toContain(created.key);
	const auth = await authenticate(created.key);
	expect(auth).toMatchObject({
		id: created.id,
		kind: "legacy",
		mailboxIds: ["mailbox"],
		scopes: ["read", "calendar:read"],
	});
	expect((await authenticate(created.key, true))?.id).toBe(created.id);
	expect(
		(await listManagedKeys(owner, "personal"))[0]?.lastUsedAt,
	).not.toBeNull();
	expect(await listManagedKeys(stranger, "personal")).toEqual([]);
});
test("mail scopes require readable mailboxes and calendar-only keys can have none", async () => {
	await expect(
		createManagedKey(owner, "personal", input(["read"], [])),
	).rejects.toMatchObject({ status: 400 });
	await expect(
		createManagedKey(stranger, "personal", input()),
	).rejects.toMatchObject({ status: 403 });
	const calendar = await createManagedKey(
		stranger,
		"personal",
		input(["calendar:read"], []),
	);
	expect((await authenticate(calendar.key))?.mailboxIds).toEqual([]);
	enableTeamSharing(state.db);
	state.db.exec(
		"INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES ('grant','mailbox','stranger','read_only',1)",
	);
	const shared = await createManagedKey(stranger, "personal", input());
	expect((await authenticate(shared.key))?.mailboxIds).toEqual(["mailbox"]);
});
test("MCP keys cannot silently become unrestricted, including source keys with the legacy flag", async () => {
	const created = await createManagedKey(owner, "mcp", input(["mcp:read"]));
	state.db
		.query("UPDATE api_keys SET mailbox_scope_enabled=0 WHERE id=?")
		.run(created.id);
	expect((await authenticate(created.key))?.mailboxIds).toEqual(["mailbox"]);
	state.db
		.query("DELETE FROM mcp_key_mailboxes WHERE key_id=?")
		.run(created.id);
	expect((await authenticate(created.key))?.mailboxIds).toEqual([]);
	expect((await listManagedKeys(owner, "mcp"))[0]?.id).toBe(created.id);
});
test("administrative keys require the current primary admin and remain separate from personal keys", async () => {
	await expect(
		createManagedKey(stranger, "admin", {
			name: "Admin",
			scopes: ["accounts"],
		}),
	).rejects.toMatchObject({ status: 403 });
	const created = await createManagedKey(owner, "admin", {
		name: "Admin",
		scopes: ["domains", "accounts"],
		mcpAllowed: true,
	});
	expect((await listManagedKeys(owner, "admin"))[0]).toMatchObject({
		kind: "mcp",
		scopes: '["domains","accounts"]',
	});
	expect(await listManagedKeys(owner, "personal")).toEqual([]);
	await expect(
		revokeManagedKey(owner, "personal", created.id),
	).rejects.toMatchObject({ status: 403 });
	state.db
		.query("UPDATE api_keys SET scopes=? WHERE id=?")
		.run('["domains","read","*"]', created.id);
	expect((await authenticate(created.key))?.scopes).toEqual(["domains"]);
	state.db.exec("UPDATE users SET is_primary_admin=0 WHERE id='owner'");
	await expect(listManagedKeys(owner, "admin")).rejects.toMatchObject({
		status: 403,
	});
});
test("revocation cancels pending approvals and deletes key grants without affecting other owners", async () => {
	const key = await createManagedKey(owner, "personal", input());
	state.db
		.query(
			"INSERT INTO agent_send_approvals(id,draft_id,mailbox_id,user_id,request_key_id,revision,payload_hash,expires_at,created_at) VALUES ('approval','message','mailbox','owner',?,0,'hash',9999999999,1)",
		)
		.run(key.id);
	await expect(
		revokeManagedKey(stranger, "personal", key.id),
	).rejects.toMatchObject({ status: 404 });
	await revokeManagedKey(owner, "personal", key.id);
	expect(await authenticate(key.key)).toBeNull();
	expect(
		state.db
			.query("SELECT status,request_key_id FROM agent_send_approvals")
			.get(),
	).toEqual({ status: "cancelled", request_key_id: null });
	expect(
		state.db.query("SELECT count(*) AS n FROM mcp_key_mailboxes").get(),
	).toEqual({ n: 0 });
});
test("revocation during password-hash verification prevents stale authentication", async () => {
	const key = await createManagedKey(owner, "personal", input());
	let release = () => {},
		entered = () => {};
	const ready = new Promise<void>((resolve) => {
			entered = resolve;
		}),
		gate = new Promise<void>((resolve) => {
			release = resolve;
		});
	const compare = bcrypt.compare;
	const mock = spyOn(bcrypt, "compare").mockImplementation(
		async (value, hash) => {
			entered();
			await gate;
			return compare(value, hash);
		},
	);
	try {
		const auth = authenticate(key.key);
		await ready;
		await revokeManagedKey(owner, "personal", key.id);
		release();
		expect(await auth).toBeNull();
	} finally {
		release();
		mock.mockRestore();
	}
});
test("general settings enforce primary ownership, partial updates and live attachment/storage limits", async () => {
	const request = (body: unknown) =>
		new Request("http://localhost/api/admin/general", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	await expect(
		adminSettingsApi(request({ outboundAttachmentMaxMb: 1 }), stranger),
	).rejects.toMatchObject({ status: 403 });
	expect(
		await (await adminSettingsApi(
			request({ outboundAttachmentMaxMb: 1 }),
			owner,
		))!.json(),
	).toEqual({ outboundAttachmentMaxMb: 1, driveStorageLimitGb: null });
	expect(await attachmentLimit()).toBe(1_000_000);
	await adminSettingsApi(request({ driveStorageLimitGb: 1 }), owner);
	expect(
		await (await adminSettingsApi(
			new Request("http://localhost/api/admin/general"),
			owner,
		))!.json(),
	).toEqual({ outboundAttachmentMaxMb: 1, driveStorageLimitGb: 1 });
	await expect(
		startUpload(owner, { name: "too big", size: 1024 ** 3 + 1 }),
	).rejects.toMatchObject({ status: 413 });
	const draft = await saveDraft(owner, {
		mailboxId: "mailbox",
		to: "x@example.net",
		cc: "",
		bcc: "",
		subject: "Quota",
		text: "Test",
		html: "",
	});
	await expect(
		uploadAttachments(owner, draft.id, [
			new File([new Uint8Array(1_000_001)], "large.bin"),
		]),
	).rejects.toThrow();
	await expect(
		adminSettingsApi(request({ outboundAttachmentMaxMb: 26 }), owner),
	).rejects.toThrow();
});
test("activity and audit views preserve login/logout metadata and remain primary-only", async () => {
	const request = new Request("http://localhost", {
		headers: {
			"CF-Connecting-IP": "192.0.2.1",
			"CF-IPCity": "Test City",
			"CF-IPCountry": "IT",
			"User-Agent": "Mozilla/5.0 (iPhone)",
		},
	});
	await recordAuthActivity("auth.login", owner.id, request);
	await recordAuthActivity("auth.mfa_verified", owner.id, request);
	await recordAuthActivity("auth.logout", stranger.id, request);
	const response = await adminSettingsApi(
		new Request("http://localhost/api/activity"),
		owner,
	);
	const data = await response!.json();
	expect(data.activities).toHaveLength(2);
	expect(JSON.parse(data.activities[0].metadata)).toMatchObject({
		ipAddress: "192.0.2.1",
		device: "Mobile",
		platform: "iOS",
		city: "Test City",
	});
	await expect(
		adminSettingsApi(new Request("http://localhost/api/audit-logs"), stranger),
	).rejects.toMatchObject({ status: 403 });
});

test("profile capability flags match the source navigation contract while retaining primary-admin identity", async () => {
	const { dispatchMailApi } = await import("../src/server/api/mail");
	const response = await dispatchMailApi(
		new Request("http://localhost/api/auth/me"),
		owner,
	);
	expect(await response.json()).toMatchObject({
		user: {
			isPrimaryAdmin: true,
			canManageMailboxes: false,
			canManageDomains: false,
			canManageUsers: false,
		},
	});
});
