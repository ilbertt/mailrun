import { authenticateApiKey } from "../src/server/auth/api-key";
import { apiKeyPrincipal } from "../src/server/auth/key-principal";
import { getEmailState } from "../src/server/jmap/state";
import { loadMessages } from "../src/server/jmap/repository";
import type { JmapContext } from "../src/server/jmap/types";
import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { fixture, owner, stranger, enableTeamSharing } from "./fixtures";
import { createManagedKey } from "../src/server/auth/key-management";
import { handleJmapRequest } from "../src/server/jmap/handler";
import {
	CAPABILITY_CORE,
	CAPABILITY_MAIL,
	CAPABILITY_SUBMISSION,
} from "../src/server/jmap/constants";
import { saveInstallation } from "../src/server/cloudflare/installation";
import { LocalStorage } from "../src/server/storage";
import { bulkAction } from "../src/server/mail/message-actions";
import type { CloudflareFetch } from "../src/server/cloudflare/client";
let state: Awaited<ReturnType<typeof fixture>>, key: string;
beforeEach(async () => {
	state = await fixture();
	key = (
		await createManagedKey(owner, "personal", {
			name: "Mail client",
			scopes: ["jmap"],
			mailboxIds: ["mailbox"],
		})
	).key;
});
afterEach(async () => {
	await state.close();
});
const request = (path: string, method = "GET", body?: unknown, token = key) =>
	new Request("https://mail.example.com" + path, {
		method,
		headers: {
			Authorization: "Bearer " + token,
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
const call = async (
	methods: [string, Record<string, unknown>, string][],
	send?: CloudflareFetch,
) => {
	const response = await handleJmapRequest(
		request("/jmap/api", "POST", {
			using: [CAPABILITY_CORE, CAPABILITY_MAIL, CAPABILITY_SUBMISSION],
			methodCalls: methods,
		}),
		send,
	);
	expect(response.status).toBe(200);
	return await response.json();
};
const draft = (subject = "Draft") => ({
	mailboxIds: { "mailbox~drafts": true },
	from: [{ email: "hello@example.com" }],
	to: [{ email: "recipient@example.org" }],
	subject,
	bodyValues: { text: { value: "Draft body" } },
	textBody: [{ partId: "text" }],
});
async function createDraft() {
	const response = await call([
		["Email/set", { accountId: "owner", create: { draft: draft() } }, "c"],
	]);
	return response.methodResponses[0][1].created.draft.id as string;
}
async function upload(content: string, token = key) {
	const response = await handleJmapRequest(
		new Request("https://mail.example.com/jmap/upload/owner", {
			method: "POST",
			headers: {
				Authorization: "Bearer " + token,
				"Content-Type": "message/rfc822",
			},
			body: content,
		}),
	);
	expect(response.status).toBe(201);
	return (await response.json()).blobId as string;
}
const mime =
	"From: hello@example.com\r\nTo: recipient@example.org\r\nMessage-ID: <jmap-import@example.org>\r\nSubject: Imported draft\r\nDate: Wed, 15 Jan 2025 12:34:56 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nMIME draft body";
test("JMAP discovery, Bearer/Basic auth, scopes and the source session capabilities are available", async () => {
	const old = process.env.APP_URL;
	process.env.APP_URL = "https://mail.example.com";
	try {
		const known = await handleJmapRequest(
			new Request("https://mail.example.com/.well-known/jmap"),
		);
		expect(known.status).toBe(301);
		expect(known.headers.get("location")).toBe(
			"https://mail.example.com/jmap/session",
		);
	} finally {
		if (old === undefined) delete process.env.APP_URL;
		else process.env.APP_URL = old;
	}
	const missing = await handleJmapRequest(
		new Request("https://mail.example.com/jmap/session"),
	);
	expect(missing.status).toBe(401);
	expect(missing.headers.get("www-authenticate")).toContain("Mailflare JMAP");
	const basic = await handleJmapRequest(
		new Request("https://mail.example.com/jmap/session", {
			headers: { Authorization: "Basic " + btoa("ignored:" + key) },
		}),
	);
	expect(basic.status).toBe(200);
	expect(await basic.json()).toMatchObject({
		username: owner.email,
		capabilities: {
			[CAPABILITY_CORE]: {
				maxCallsInRequest: 32,
				maxSizeUpload: 10 * 1024 * 1024,
			},
		},
		primaryAccounts: { [CAPABILITY_MAIL]: "owner" },
	});
	const read = (
		await createManagedKey(owner, "personal", {
			name: "Reader",
			scopes: ["read"],
			mailboxIds: ["mailbox"],
		})
	).key;
	expect(
		(await handleJmapRequest(request("/jmap/session", "GET", undefined, read)))
			.status,
	).toBe(403);
	expect(
		(
			await handleJmapRequest(
				new Request("https://mail.example.com/jmap/api", { method: "OPTIONS" }),
			)
		).headers.get("access-control-allow-origin"),
	).toBe("*");
});
test("mailboxes expose stable account/role/folder IDs, counts, filtering and requested properties", async () => {
	const response = await call([
		[
			"Mailbox/get",
			{
				accountId: "owner",
				properties: ["name", "role", "totalEmails", "myRights"],
			},
			"m",
		],
		["Mailbox/query", { accountId: "owner", filter: { role: "inbox" } }, "q"],
	]);
	const boxes = response.methodResponses[0][1];
	expect(boxes.list).toHaveLength(7);
	expect(
		boxes.list.find((box: { id: string }) => box.id === "mailbox~inbox"),
	).toMatchObject({
		role: "inbox",
		totalEmails: 1,
		myRights: { mayReadItems: true, maySubmit: true },
	});
	expect(boxes.list[0]).not.toHaveProperty("unreadEmails");
	expect(response.methodResponses[1][1].ids).toEqual(["mailbox~inbox"]);
});
test("method references, created IDs, account boundaries and request errors preserve protocol response shapes", async () => {
	const response = await call([
		["Mailbox/query", { accountId: "owner", filter: { role: "inbox" } }, "q"],
		[
			"Mailbox/get",
			{
				accountId: "owner",
				"#ids": { resultOf: "q", name: "Mailbox/query", path: "/ids" },
			},
			"g",
		],
		["Core/echo", { text: "hello" }, "e"],
		["Email/get", { accountId: "someone-else", ids: ["message"] }, "x"],
		["toString", {}, "bad"],
	]);
	expect(response.methodResponses[1][1].list[0].id).toBe("mailbox~inbox");
	expect(response.methodResponses[2]).toEqual([
		"Core/echo",
		{ text: "hello" },
		"e",
	]);
	expect(response.methodResponses[3][1].type).toBe("accountNotFound");
	expect(response.methodResponses[4][1].type).toBe("unknownMethod");
	const invalid = await handleJmapRequest(
		request("/jmap/api", "POST", { using: ["unknown"], methodCalls: [] }),
	);
	expect(invalid.status).toBe(400);
	expect((await invalid.json()).type).toContain("unknownCapability");
});
test("Email/query supports recursive boolean conditions, headers, dates, keywords, text, ordering and anchors", async () => {
	state.db.exec(
		"UPDATE messages SET provider_message_id='<root@example.org>',thread_id='root',starred=1; INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,text_body,status,read,created_at) VALUES('newer','owner','mailbox','inbound','other@example.org','hello@example.com','A second subject','Body two','received',1,100),('unwanted','owner','mailbox','inbound','other@example.org','hello@example.com','Ignore','Body three','spam',0,101)",
	);
	const response = await call([
		[
			"Email/query",
			{
				accountId: "owner",
				filter: {
					operator: "AND",
					conditions: [
						{ inMailbox: "mailbox~inbox" },
						{
							operator: "OR",
							conditions: [{ subject: "searchable" }, { hasKeyword: "$seen" }],
						},
					],
				},
				sort: [{ property: "subject", isAscending: true }],
				calculateTotal: true,
			},
			"q",
		],
		[
			"Email/query",
			{
				accountId: "owner",
				filter: { header: ["Message-ID", "root@example.org"] },
			},
			"h",
		],
		[
			"Email/query",
			{
				accountId: "owner",
				filter: { operator: "NOT", conditions: [{ subject: "Ignore" }] },
				sort: [{ property: "receivedAt", isAscending: false }],
				anchor: "newer",
				anchorOffset: 1,
			},
			"a",
		],
	]);
	expect(response.methodResponses[0][1]).toMatchObject({
		ids: ["message", "newer"],
		total: 2,
	});
	expect(response.methodResponses[1][1].ids).toEqual(["message"]);
	expect(response.methodResponses[2][1].ids).toEqual(["message"]);
	const unsupported = await call([
		["Email/query", { filter: { header: ["X-Unstored", "anything"] } }, "u"],
	]);
	expect(unsupported.methodResponses[0][1].type).toBe("unsupportedFilter");
});
test("shared mailboxes honor scoped keys and keep other authors private drafts out of reads, counts and blobs", async () => {
	enableTeamSharing(state.db);
	state.db.exec(
		"INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES('share','mailbox','stranger','read_only',1); INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,status,created_at) VALUES('private','stranger','mailbox','outbound','hello@example.com','hidden@example.org','Secret','draft',2)",
	);
	const response = await call([
		["Email/query", {}, "q"],
		["Email/get", { ids: ["private", "message"] }, "g"],
		["Mailbox/get", { ids: ["mailbox~drafts"] }, "m"],
	]);
	expect(response.methodResponses[0][1].ids).not.toContain("private");
	expect(response.methodResponses[1][1].notFound).toEqual(["private"]);
	expect(response.methodResponses[2][1].list[0].totalEmails).toBe(0);
	const hidden = await handleJmapRequest(
		request("/jmap/download/owner/msg~private/draft.eml"),
	);
	expect(hidden.status).toBe(404);
});
test("structured drafts and imported MIME retain bodies, keywords, raw bytes and atomic upload claims", async () => {
	const id = await createDraft();
	const get = await call([
		[
			"Email/get",
			{
				ids: [id],
				fetchAllBodyValues: true,
				properties: [
					"subject",
					"bodyValues",
					"keywords",
					"header:From:asAddresses",
				],
			},
			"g",
		],
	]);
	expect(get.methodResponses[0][1].list[0]).toMatchObject({
		subject: "Draft",
		bodyValues: { "1": { value: "Draft body" } },
		keywords: { $draft: true, $seen: true },
	});
	const blobId = await upload(mime);
	const response = await call([
		[
			"Email/import",
			{
				accountId: "owner",
				emails: {
					upload: {
						blobId,
						mailboxIds: { "mailbox~drafts": true },
						keywords: { $flagged: true },
					},
				},
			},
			"i",
		],
	]);
	const imported = response.methodResponses[0][1].created.upload;
	expect(imported.id).toBeString();
	expect(
		state.db
			.query("SELECT provider_message_id,starred FROM messages WHERE id=?")
			.get(imported.id),
	).toEqual({ provider_message_id: "<jmap-import@example.org>", starred: 1 });
	const raw = await handleJmapRequest(
		request(
			`/jmap/download/owner/${encodeURIComponent(imported.blobId)}/original.eml`,
		),
	);
	expect(await raw.text()).toBe(mime);
	expect(state.db.query("SELECT id FROM mailrun_jmap_uploads").all()).toEqual(
		[],
	);
	const again = await call([
		[
			"Email/import",
			{ emails: { again: { blobId, mailboxIds: { "mailbox~drafts": true } } } },
			"i",
		],
	]);
	expect(again.methodResponses[0][1].notCreated.again.type).toBe(
		"blobNotFound",
	);
});
test("two imports cannot claim the same MIME upload", async () => {
	const blobId = await upload(mime),
		invoke = () =>
			call([
				[
					"Email/import",
					{
						emails: {
							draft: { blobId, mailboxIds: { "mailbox~drafts": true } },
						},
					},
					"i",
				],
			]);
	const results = await Promise.all([invoke(), invoke()]);
	expect(
		results.filter((value) => value.methodResponses[0][1].created.draft),
	).toHaveLength(1);
	expect(
		state.db
			.query(
				"SELECT id FROM messages WHERE provider_message_id='<jmap-import@example.org>'",
			)
			.all(),
	).toHaveLength(1);
});
test("upload and attachment failures keep draft creation atomic and leave a reusable upload", async () => {
	const blobId = await upload(mime),
		put = spyOn(LocalStorage.prototype, "put").mockRejectedValue(
			new Error("Disk full"),
		);
	try {
		const result = await call([
			[
				"Email/import",
				{
					emails: { draft: { blobId, mailboxIds: { "mailbox~drafts": true } } },
				},
				"i",
			],
		]);
		expect(result.methodResponses[0][1].notCreated.draft).toBeDefined();
		expect(
			state.db
				.query(
					"SELECT id FROM messages WHERE provider_message_id='<jmap-import@example.org>'",
				)
				.all(),
		).toEqual([]);
		expect(
			state.db.query("SELECT id FROM mailrun_jmap_uploads").all(),
		).toHaveLength(1);
	} finally {
		put.mockRestore();
	}
});
test("folders and email keyword/move/destroy operations update state and reject read-only shares", async () => {
	let response = await call([
		[
			"Mailbox/set",
			{
				accountId: "owner",
				create: { folder: { parentId: "mailbox", name: "Client folder" } },
			},
			"f",
		],
	]);
	const folder = response.methodResponses[0][1].created.folder.id;
	response = await call([
		[
			"Email/set",
			{
				update: {
					message: {
						keywords: { $seen: true, $flagged: true },
						mailboxIds: { [folder]: true },
					},
				},
			},
			"u",
		],
	]);
	expect(response.methodResponses[0][1].updated.message).toBeNull();
	expect(
		state.db
			.query("SELECT read,starred,status FROM messages WHERE id='message'")
			.get(),
	).toEqual({ read: 1, starred: 1, status: "received" });
	const blocked = await call([["Mailbox/set", { destroy: [folder] }, "d"]]);
	expect(blocked.methodResponses[0][1].notDestroyed[folder].type).toBe(
		"mailboxHasEmail",
	);
	response = await call([["Email/set", { destroy: ["message"] }, "d"]]);
	expect(response.methodResponses[0][1].destroyed).toEqual(["message"]);
	expect(
		state.db.query("SELECT status FROM messages WHERE id='message'").get(),
	).toEqual({ status: "trash" });
	await call([["Email/set", { destroy: ["message"] }, "d"]]);
	expect(
		state.db.query("SELECT id FROM messages WHERE id='message'").all(),
	).toEqual([]);
});
test("Identity/get and EmailSubmission/set send a draft once and append the implicit Email/set response", async () => {
	await saveInstallation({
		accountId: "a".repeat(32),
		zoneId: "zone",
		hostname: "example.com",
		workerName: "fixture",
		publicOrigin: "https://mail.example.com",
		apiToken: "synthetic",
		relaySecret: "secret",
		relayVersion: "fixture",
	});
	const id = await createDraft(),
		identities = await call([["Identity/get", {}, "i"]]),
		identity = identities.methodResponses[0][1].list[0].id;
	let posted = 0;
	const result = await call(
		[
			[
				"EmailSubmission/set",
				{
					create: { submission: { emailId: id, identityId: identity } },
					onSuccessDestroyEmail: ["#submission"],
				},
				"s",
			],
		],
		async () => {
			posted++;
			return Response.json({
				success: true,
				result: { message_id: "jmap-sent" },
			});
		},
	);
	expect(posted).toBe(1);
	const sent = result.methodResponses[0][1].created.submission;
	expect(sent.id).not.toBe(id);
	expect(result.methodResponses[1]).toMatchObject([
		"Email/set",
		{ destroyed: [id] },
		"s",
	]);
	expect(state.db.query("SELECT id FROM messages WHERE id=?").all(id)).toEqual(
		[],
	);
	expect(
		state.db.query("SELECT status FROM messages WHERE id=?").get(sent.id),
	).toEqual({ status: "sent" });
	const again = await call(
		[
			[
				"EmailSubmission/set",
				{ create: { again: { emailId: id, identityId: identity } } },
				"s",
			],
		],
		async () => {
			posted++;
			throw new Error("Must not send");
		},
	);
	expect(posted).toBe(1);
	expect(again.methodResponses[0][1].notCreated.again).toBeDefined();
});
test("submission failure retains the original draft and reports a per-object failure", async () => {
	await saveInstallation({
		accountId: "a".repeat(32),
		zoneId: "zone",
		hostname: "example.com",
		workerName: "fixture",
		publicOrigin: "https://mail.example.com",
		apiToken: "synthetic",
		relaySecret: "secret",
		relayVersion: "fixture",
	});
	const id = await createDraft(),
		identity = (await call([["Identity/get", {}, "i"]])).methodResponses[0][1]
			.list[0].id;
	const result = await call(
		[
			[
				"EmailSubmission/set",
				{ create: { send: { emailId: id, identityId: identity } } },
				"s",
			],
		],
		async () =>
			Response.json(
				{ success: false, errors: [{ message: "Provider unavailable" }] },
				{ status: 503 },
			),
	);
	expect(result.methodResponses[0][1].notCreated.send.type).toBe("forbidden");
	expect(
		state.db.query("SELECT status FROM messages WHERE id=?").get(id),
	).toEqual({ status: "draft" });
});
test("eventsource emits current states and closes in closeafter=state mode", async () => {
	const response = await handleJmapRequest(
		request("/jmap/eventsource?closeafter=state"),
	);
	expect(response.headers.get("content-type")).toBe("text/event-stream");
	expect(await response.text()).toContain('"@type":"StateChange"');
});

test("malformed envelopes and result references return protocol errors without aborting later calls", async () => {
	for (const body of [
		[],
		{ using: [CAPABILITY_CORE], methodCalls: [["Core/echo", null, "e"]] },
		{ using: [CAPABILITY_CORE], methodCalls: [], createdIds: { bad: 123 } },
	]) {
		const result = await handleJmapRequest(request("/jmap/api", "POST", body));
		expect(result.status).toBe(400);
		expect(await result.json()).toMatchObject({
			type: "urn:ietf:params:jmap:error:notRequest",
		});
	}
	const response = await call([
		["Core/echo", { ids: 7, nested: [1, 2] }, "e"],
		["Email/get", { "#ids": null }, "r"],
		[
			"Email/get",
			{ "#ids": { resultOf: "e", name: "Core/echo", path: "/__proto__" } },
			"p",
		],
		["Mailbox/get", { ids: "mailbox" }, "m"],
		["Mailbox/set", { create: { bad: null } }, "s"],
		["Core/echo", { alive: true }, "last"],
	]);
	expect(response.methodResponses.map((row: unknown[]) => row[1])).toEqual([
		{ ids: 7, nested: [1, 2] },
		{ type: "invalidResultReference" },
		{
			type: "invalidResultReference",
			description: "Path /__proto__ not found",
		},
		{
			type: "invalidArguments",
			description: "ids must be an array of strings",
		},
		{ type: "invalidArguments", description: "create must map ids to objects" },
		{ alive: true },
	]);
});

test("read-only and send-as shares preserve JMAP write and folder-management boundaries", async () => {
	const folder = (
		await call([
			[
				"Mailbox/set",
				{ create: { folder: { parentId: "mailbox", name: "Owned folder" } } },
				"f",
			],
		])
	).methodResponses[0][1].created.folder.id;
	enableTeamSharing(state.db);
	state.db.exec(
		"INSERT INTO mailbox_access(id,user_id,mailbox_id,permission,created_at) VALUES('share','stranger','mailbox','read_only',1)",
	);
	key = (
		await createManagedKey(stranger, "personal", {
			name: "Shared mail client",
			scopes: ["jmap"],
			mailboxIds: ["mailbox"],
		})
	).key;
	let result = await call([
		[
			"Email/set",
			{ update: { message: { "keywords/$seen": true } }, destroy: ["message"] },
			"e",
		],
		["Mailbox/set", { update: { [folder]: { name: "Renamed" } } }, "f"],
	]);
	expect(result.methodResponses[0][1].notUpdated.message.type).toBe(
		"forbidden",
	);
	expect(result.methodResponses[0][1].notDestroyed.message.type).toBe(
		"forbidden",
	);
	expect(result.methodResponses[1][1].notUpdated[folder].type).toBe(
		"forbidden",
	);
	state.db.exec(
		"UPDATE mailbox_access SET permission='send_as' WHERE id='share'",
	);
	result = await call([
		["Email/set", { update: { message: { "keywords/$seen": true } } }, "e"],
		["Mailbox/set", { update: { [folder]: { name: "Renamed" } } }, "f"],
	]);
	expect(result.methodResponses[0][1].updated.message).toBeNull();
	expect(result.methodResponses[1][1].notUpdated[folder].type).toBe(
		"forbidden",
	);
	state.db.exec(
		"UPDATE mailbox_access SET permission='full_access' WHERE id='share'",
	);
	result = await call([
		["Mailbox/set", { update: { [folder]: { name: "Renamed" } } }, "f"],
	]);
	expect(result.methodResponses[0][1].updated[folder]).toBeNull();
});

test("uploads enforce size, account ownership and live grants before committing metadata", async () => {
	const blobId = await upload(mime);
	enableTeamSharing(state.db);
	state.db.exec(
		"INSERT INTO mailbox_access(id,user_id,mailbox_id,permission,created_at) VALUES('upload-share','stranger','mailbox','read_only',1)",
	);
	key = (
		await createManagedKey(stranger, "personal", {
			name: "Other user",
			scopes: ["jmap"],
			mailboxIds: ["mailbox"],
		})
	).key;
	const foreign = await handleJmapRequest(
		request(`/jmap/download/stranger/${blobId}/draft.eml`),
	);
	expect(foreign.status).toBe(404);
	const oversized = await handleJmapRequest(
		new Request("https://mail.example.com/jmap/upload/stranger", {
			method: "POST",
			headers: { Authorization: "Bearer " + key },
			body: new Uint8Array(10 * 1024 * 1024 + 1),
		}),
	);
	expect(oversized.status).toBe(413);
	const original = LocalStorage.prototype.put;
	const put = spyOn(LocalStorage.prototype, "put").mockImplementation(
		async function (
			this: LocalStorage,
			...args: Parameters<LocalStorage["put"]>
		) {
			await original.apply(this, args);
			state.db.exec("DELETE FROM api_keys WHERE user_id='stranger'");
		},
	);
	try {
		const revoked = await handleJmapRequest(
			new Request("https://mail.example.com/jmap/upload/stranger", {
				method: "POST",
				headers: { Authorization: "Bearer " + key },
				body: "staged before revocation",
			}),
		);
		expect(revoked.status).toBe(401);
		expect(
			state.db
				.query("SELECT id FROM mailrun_jmap_uploads WHERE user_id='stranger'")
				.all(),
		).toEqual([]);
	} finally {
		put.mockRestore();
	}
});

test("query escaping treats percent, underscore, backslash and the escape marker literally", async () => {
	state.db.exec(
		"UPDATE messages SET subject='Literal 50%_! path\\name' WHERE id='message'",
	);
	for (const subject of ["50%_!", "path\\name", "%", "_"]) {
		const response = await call([
			["Email/query", { filter: { subject } }, "q"],
		]);
		expect(response.methodResponses[0][1].ids).toEqual(["message"]);
	}
	const response = await call([
		["Email/query", { filter: { subject: "50xx!" } }, "q"],
	]);
	expect(response.methodResponses[0][1].ids).toEqual([]);
});

test("submission reservation blocks competing JMAP and UI mutations while a provider request is pending", async () => {
	await saveInstallation({
		accountId: "a".repeat(32),
		zoneId: "zone",
		hostname: "example.com",
		workerName: "fixture",
		publicOrigin: "https://mail.example.com",
		apiToken: "synthetic",
		relaySecret: "secret",
		relayVersion: "fixture",
	});
	const id = await createDraft();
	const identity = (await call([["Identity/get", {}, "i"]]))
		.methodResponses[0][1].list[0].id;
	const started = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let posted = 0;
	const pending = call(
		[
			[
				"EmailSubmission/set",
				{ create: { send: { emailId: id, identityId: identity } } },
				"s",
			],
		],
		async () => {
			posted++;
			started.resolve();
			await release.promise;
			return Response.json({
				success: true,
				result: { message_id: "reserved-jmap-send" },
			});
		},
	);
	await started.promise;
	const duplicate = call(
		[
			[
				"EmailSubmission/set",
				{ create: { duplicate: { emailId: id, identityId: identity } } },
				"s",
			],
		],
		async () => {
			posted++;
			return Response.json({
				success: true,
				result: { message_id: "duplicate-must-not-send" },
			});
		},
	);
	try {
		const raced = await call([
			[
				"Email/set",
				{
					destroy: [id],
					update: { [id]: { mailboxIds: { "mailbox~trash": true } } },
				},
				"d",
			],
		]);
		expect(raced.methodResponses[0][1].notDestroyed[id].type).toBe("forbidden");
		expect(raced.methodResponses[0][1].notUpdated[id].type).toBe("forbidden");
		await expect(
			bulkAction(owner, { action: "trash", messageIds: [id] }),
		).rejects.toMatchObject({ status: 409 });
	} finally {
		release.resolve();
		await pending;
	}
	const duplicateResult = await duplicate;
	expect(
		duplicateResult.methodResponses[0][1].notCreated.duplicate,
	).toBeDefined();
	expect(posted).toBe(1);
	expect(state.db.query("SELECT id FROM messages WHERE id=?").all(id)).toEqual(
		[],
	);
});

test("long-lived JMAP contexts refresh individual mailbox grants and never fall back to owner-wide reads", async () => {
	const auth = await authenticateApiKey(request("/jmap/session"));
	if (!auth) throw new Error("Fixture key did not authenticate");
	const ctx: JmapContext = {
		auth: { ...auth, userId: auth.user.id, email: auth.user.email },
		actor: apiKeyPrincipal(auth, "jmap"),
		accountId: owner.id,
		origin: "https://mail.example.com",
		createdIds: Object.create(null),
	};
	expect(await getEmailState(ctx)).toContain("mailbox");
	expect(await loadMessages(ctx, ["message"])).toHaveLength(1);
	state.db.query("DELETE FROM mcp_key_mailboxes WHERE key_id=?").run(auth.id);
	expect(await getEmailState(ctx)).toBe("[]");
	expect(await loadMessages(ctx, ["message"])).toEqual([]);
	state.db.query("DELETE FROM api_keys WHERE id=?").run(auth.id);
	await expect(getEmailState(ctx)).rejects.toMatchObject({ status: 401 });
});

test("only authenticated JMAP batches and state streams disable the native HTTP idle timeout", async () => {
	let disabled = 0;
	const extend = () => {
		disabled++;
	};
	await handleJmapRequest(
		new Request("https://mail.example.com/jmap/api", { method: "POST" }),
		undefined,
		extend,
	);
	expect(disabled).toBe(0);
	await handleJmapRequest(request("/jmap/session"), undefined, extend);
	expect(disabled).toBe(0);
	await handleJmapRequest(
		request("/jmap/api", "POST", {
			using: [CAPABILITY_CORE],
			methodCalls: [["Core/echo", { alive: true }, "e"]],
		}),
		undefined,
		extend,
	);
	expect(disabled).toBe(1);
	const events = await handleJmapRequest(
		request("/jmap/eventsource?closeafter=state"),
		undefined,
		extend,
	);
	await events.text();
	expect(disabled).toBe(2);
});

test("queued submissions protect both copies before provider claiming and tolerate malformed legacy job payloads", async () => {
	const old = await createDraft(),
		sentCopy = await createDraft();
	state.db
		.query("UPDATE messages SET status='queued' WHERE id IN(?,?)")
		.run(old, sentCopy);
	state.db
		.query(
			"INSERT INTO outbound_jobs(id,user_id,message_id,status,payload,created_at,updated_at) VALUES('reserved','owner',?,'queued',?,1,1)",
		)
		.run(sentCopy, JSON.stringify({ submittedDraftId: old }));
	state.db.exec(
		"INSERT INTO outbound_jobs(id,user_id,message_id,status,payload,created_at,updated_at) VALUES('malformed','owner','message','failed','broken legacy payload',1,1)",
	);
	const result = await call([["Email/set", { destroy: [old, sentCopy] }, "d"]]);
	for (const id of [old, sentCopy]) {
		expect(result.methodResponses[0][1].notDestroyed[id].type).toBe(
			"forbidden",
		);
		await expect(
			bulkAction(owner, { messageIds: [id], action: "trash" }),
		).rejects.toMatchObject({ status: 409 });
	}
	await bulkAction(owner, { messageIds: ["message"], action: "trash" });
	expect(
		state.db.query("SELECT status FROM messages WHERE id='message'").get(),
	).toEqual({ status: "trash" });
});
