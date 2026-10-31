import { z } from "zod";
import { writeBackup, restoreBackup } from "../src/lib/backups/export";
import { deliverJob } from "../src/server/mail/send";
import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { fixture, owner, stranger, enableTeamSharing } from "./fixtures";
import {
	createManagedKey,
	revokeManagedKey,
} from "../src/server/auth/key-management";
import { handleMcpRequest } from "../src/server/mcp/handler";
import {
	authenticateMcpRequest,
	requireMcpScope,
} from "../src/server/mcp/auth";
import { runEmailTool } from "../src/server/agent/tools";
import {
	getAgentSendRequest,
	confirmAgentSend,
} from "../src/server/agent/approvals";
import {
	saveDraft,
	getDraft,
	uploadAttachments,
	removeAttachment,
} from "../src/server/mail/drafts";
import { LocalStorage } from "../src/server/storage";
import { saveInstallation } from "../src/server/cloudflare/installation";
import { allowAgentRequest } from "../src/server/agent/rate-limit";
import { runCalendarTool } from "../src/server/calendar/tools";
import type { AgentToolContext } from "../src/server/agent/types";
let state: Awaited<ReturnType<typeof fixture>>, key: string;
beforeEach(async () => {
	state = await fixture();
	key = (
		await createManagedKey(owner, "mcp", {
			name: "MCP client",
			scopes: [
				"mcp:read",
				"mcp:draft",
				"mcp:organize",
				"mcp:request-send",
				"mcp:calendar-read",
				"mcp:calendar-write",
			],
			mailboxIds: ["mailbox"],
		})
	).key;
});
afterEach(() => state.close());
const req = (
	body: unknown,
	token = key,
	method = "POST",
	extra: Record<string, string> = {},
) =>
	new Request("http://localhost:3000/mcp", {
		method,
		headers: {
			Authorization: "Bearer " + token,
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
			...extra,
		},
		body: method === "POST" ? JSON.stringify(body) : undefined,
	});
async function rpc(
	method: string,
	params: unknown = {},
	token = key,
	extra: Record<string, string> = {},
) {
	const response = await handleMcpRequest(
		req({ jsonrpc: "2.0", id: 1, method, params }, token, "POST", extra),
	);
	if (response.status !== 200) throw new Error(await response.text());
	const text = await response.text();
	const data = response.headers
		.get("content-type")
		?.includes("text/event-stream")
		? JSON.parse(
				text
					.split("\n")
					.find((line) => line.startsWith("data: "))!
					.slice(6),
			)
		: JSON.parse(text);
	return data;
}
async function tool(
	name: string,
	args: Record<string, unknown> = {},
	token = key,
) {
	const result = await rpc("tools/call", { name, arguments: args }, token);
	if (result.error) throw Error(JSON.stringify(result.error));
	return { ...result.result, data: JSON.parse(result.result.content[0].text) };
}
async function createDraft(token = key) {
	const result = await tool(
		"draft_email",
		{
			mailboxId: "mailbox",
			to: "recipient@example.org",
			subject: "MCP draft",
			body: "**Hello**\n\nA draft for review.",
		},
		token,
	);
	expect(result.isError).toBe(false);
	return result.data.draftId as string;
}
async function configureEmail() {
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
test("MCP uses original SDK initialization, tool schemas and source error envelope", async () => {
	const init = await rpc("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "fixture", version: "1" },
	});
	expect(init.result.serverInfo).toMatchObject({
		name: "mailflare",
		version: "0.1.0",
	});
	const tools = (await rpc("tools/list")).result.tools;
	expect(tools.map((item: { name: string }) => item.name).sort()).toEqual(
		[
			"get_schedule",
			"search_events",
			"get_event",
			"create_event",
			"update_events",
			"delete_events",
			"find_free_time",
			"get_calendars",
			"list_mailboxes",
			"list_emails",
			"get_email",
			"get_thread",
			"search_emails",
			"draft_email",
			"draft_reply",
			"mark_email_read",
			"move_email",
			"move_emails",
			"discard_draft",
			"update_draft",
			"request_send",
			"get_scheduled_send",
			"cancel_scheduled_send",
			"get_send_request",
		].sort(),
	);
	expect(
		tools.find((item: { name: string }) => item.name === "draft_reply")
			.inputSchema,
	).toMatchObject({
		type: "object",
		required: expect.arrayContaining(["mailboxId", "emailId", "body"]),
	});
	expect((await rpc("does-not-exist")).error.code).toBe(-32601);
	const invalid = await rpc("tools/call", {
		name: "draft_email",
		arguments: { mailboxId: "mailbox", to: "invalid" },
	});
	expect(invalid.result.isError).toBe(true);
});
test("only explicitly enabled Bearer MCP keys authenticate; origin, host and stateless methods stay constrained", async () => {
	const plain = (
		await createManagedKey(owner, "personal", {
			name: "API",
			scopes: ["read"],
			mailboxIds: ["mailbox"],
		})
	).key;
	expect((await handleMcpRequest(req({}, plain))).status).toBe(401);
	expect(
		(
			await handleMcpRequest(
				new Request("http://localhost:3000/mcp", {
					method: "POST",
					headers: { Authorization: "Basic " + btoa("user:" + key) },
				}),
			)
		).status,
	).toBe(401);
	expect(
		(
			await handleMcpRequest(
				req({}, key, "POST", { Origin: "https://untrusted.example" }),
			)
		).status,
	).toBe(403);
	const old = process.env.APP_URL;
	process.env.APP_URL = "https://mail.example.com";
	try {
		expect((await handleMcpRequest(req({}))).status).toBe(403);
	} finally {
		if (old === undefined) delete process.env.APP_URL;
		else process.env.APP_URL = old;
	}
	expect((await handleMcpRequest(req(undefined, key, "GET"))).status).toBe(405);
	expect((await handleMcpRequest(req(undefined, key, "DELETE"))).status).toBe(
		405,
	);
	state.db.exec(
		"UPDATE api_keys SET scopes='[\"mcp:read\",\"storage\"]' WHERE kind='mcp'",
	);
	expect((await handleMcpRequest(req({}))).status).toBe(401);
});
test("mail reads, search, cursor pagination, headers and private drafts follow source tool contracts", async () => {
	state.db.exec(
		"UPDATE messages SET thread_id='thread' WHERE id='message'; INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,text_body,thread_id,created_at) VALUES('recent','owner','mailbox','inbound','sender@example.org','hello@example.com','Recent','Second message','thread',2); INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,thread_id,created_at) VALUES('secret','stranger','mailbox','outbound','hello@example.com','someone@example.org','draft','thread',3)",
	);
	const boxes = await tool("list_mailboxes");
	expect(boxes.data).toEqual([
		{ id: "mailbox", address: "hello@example.com", displayName: null },
	]);
	const first = await tool("list_emails", { mailboxId: "mailbox", limit: 1 });
	expect(first.data.emails[0].id).toBe("recent");
	expect(first.data.nextCursor).toBe("recent");
	const next = await tool("list_emails", {
		mailboxId: "mailbox",
		limit: 1,
		cursor: first.data.nextCursor,
	});
	expect(next.data.emails[0].id).toBe("message");
	const search = await tool("search_emails", {
		mailboxId: "mailbox",
		query: "subject:searchable",
	});
	expect(search.data.emails.map((row: { id: string }) => row.id)).toEqual([
		"message",
	]);
	const read = await tool("get_email", {
		mailboxId: "mailbox",
		emailId: "message",
	});
	expect(read.data).toMatchObject({
		id: "message",
		text: "Welcome to Mailrun",
		read: false,
		attachments: [],
	});
	const thread = await tool("get_thread", {
		mailboxId: "mailbox",
		emailId: "message",
	});
	expect(thread.data.emails.map((row: { id: string }) => row.id)).toEqual([
		"message",
		"recent",
	]);
	expect(
		(await tool("get_email", { mailboxId: "mailbox", emailId: "secret" }))
			.isError,
	).toBe(true);
	expect(
		(await tool("get_email", { mailboxId: "outside", emailId: "message" })).data
			.error,
	).toBe("Permission denied");
});
test("draft/reply tools retain original prose formatting, recipients and thread references", async () => {
	state.db.exec(
		"UPDATE messages SET reply_to='reply@example.org',provider_message_id='<parent@example.org>',thread_id='thread',cc_addr='hello@example.com, colleague@example.org' WHERE id='message'",
	);
	const id = await createDraft();
	const stored = await getDraft(owner, id);
	expect(stored.text_body).toBe("Hello\n\nA draft for review.");
	expect(stored.html_body).toContain("Hello");
	const reply = await tool("draft_reply", {
			mailboxId: "mailbox",
			emailId: "message",
			body: "Tuesday works.",
			replyAll: true,
		}),
		row = await getDraft(owner, reply.data.draftId);
	expect(row).toMatchObject({
		to_addr: "reply@example.org",
		cc_addr: "colleague@example.org",
		subject: "Re: A searchable subject",
		thread_id: "thread",
		in_reply_to: "<parent@example.org>",
	});
	expect(row.references_header).toContain("parent@example.org");
	expect(
		(await tool("get_email", { mailboxId: "mailbox", emailId: id })).data,
	).toMatchObject({ revision: 1, bcc: null, scheduledAt: null });
});
test("scope revocation and shared mailbox roles apply to each tool and inside mutations", async () => {
	const reader = (
		await createManagedKey(owner, "mcp", {
			name: "Read only scope",
			scopes: ["mcp:read"],
			mailboxIds: ["mailbox"],
		})
	).key;
	expect(
		(
			await tool(
				"draft_email",
				{
					mailboxId: "mailbox",
					to: "r@example.org",
					subject: "No",
					body: "No",
				},
				reader,
			)
		).isError,
	).toBe(true);
	enableTeamSharing(state.db);
	state.db.exec(
		"INSERT INTO mailbox_access(id,user_id,mailbox_id,permission,created_at) VALUES('share','stranger','mailbox','read_only',1)",
	);
	const shared = (
		await createManagedKey(stranger, "mcp", {
			name: "Shared",
			scopes: ["mcp:read", "mcp:draft", "mcp:organize"],
			mailboxIds: ["mailbox"],
		})
	).key;
	expect(
		(
			await tool(
				"mark_email_read",
				{ mailboxId: "mailbox", emailId: "message", read: true },
				shared,
			)
		).data,
	).toEqual({ emailId: "message", read: true });
	expect(
		(
			await tool(
				"move_email",
				{ mailboxId: "mailbox", emailId: "message", destination: "trash" },
				shared,
			)
		).isError,
	).toBe(true);
	expect(
		(
			await tool(
				"draft_email",
				{
					mailboxId: "mailbox",
					to: "r@example.org",
					subject: "No",
					body: "No",
				},
				shared,
			)
		).isError,
	).toBe(true);
	state.db.exec(
		"UPDATE mailbox_access SET permission='send_as' WHERE id='share'",
	);
	const draft = await createDraft(shared);
	expect((await getDraft(stranger, draft)).user_id).toBe("stranger");
	const principal = await authenticateMcpRequest(req({}));
	if (!principal) throw Error("auth");
	const actor = await requireMcpScope(principal, "mcp:draft", "mailbox");
	state.db
		.query("DELETE FROM mcp_key_mailboxes WHERE key_id=?")
		.run(principal.keyId);
	await expect(
		runEmailTool(
			{ user: owner, actor, mailboxId: "mailbox", origin: "mcp" },
			"draft_email",
			{ to: "r@example.org", subject: "Revoked", body: "No" },
		),
	).rejects.toBeDefined();
});
test("draft edits atomically copy attachments, enforce revisions and preserve independent local files", async () => {
	const storage = new LocalStorage();
	await storage.put("inbound/file", "Attachment content");
	state.db.exec(
		"INSERT INTO message_attachments(id,message_id,filename,content_type,size,disposition,r2_key,created_at) VALUES('source-file','message','file.txt','text/plain',18,'attachment','inbound/file',1)",
	);
	const id = await createDraft();
	let result = await tool("update_draft", {
		mailboxId: "mailbox",
		draftId: id,
		expectedRevision: 1,
		body: "Updated body",
		bcc: "hidden@example.org",
		addAttachments: [{ sourceEmailId: "message", attachmentId: "source-file" }],
	});
	expect(result.data).toMatchObject({
		revision: 2,
		status: "draft_updated",
		attachmentCount: 1,
	});
	let draft = await getDraft(owner, id);
	expect(draft.bcc_addr).toBe("hidden@example.org");
	expect(draft.attachments[0]?.r2_key).not.toBe("inbound/file");
	expect(await storage.file(draft.attachments[0]!.r2_key).text()).toBe(
		"Attachment content",
	);
	expect(
		(
			await tool("update_draft", {
				mailboxId: "mailbox",
				draftId: id,
				expectedRevision: 1,
				subject: "Stale",
			})
		).isError,
	).toBe(true);
	const put = spyOn(LocalStorage.prototype, "put").mockRejectedValue(
		new Error("Disk full"),
	);
	try {
		result = await tool("update_draft", {
			mailboxId: "mailbox",
			draftId: id,
			expectedRevision: 2,
			body: "Must roll back",
			addAttachments: [
				{ sourceEmailId: "message", attachmentId: "source-file" },
			],
		});
		expect(result.isError).toBe(true);
	} finally {
		put.mockRestore();
	}
	draft = await getDraft(owner, id);
	expect(draft.text_body).toBe("Updated body");
	expect(
		state.db
			.query("SELECT revision FROM agent_draft_metadata WHERE draft_id=?")
			.get(id),
	).toEqual({ revision: 2 });
	result = await tool("update_draft", {
		mailboxId: "mailbox",
		draftId: id,
		expectedRevision: 2,
		removeAttachmentIds: [draft.attachments[0]!.id],
	});
	expect(result.data.attachmentCount).toBe(0);
	expect(await storage.file("inbound/file").exists()).toBe(true);
});
test("human saves and attachment changes advance the assistant revision and prevent discard or stale approvals", async () => {
	const id = await createDraft();
	const approval = await tool("request_send", {
		mailboxId: "mailbox",
		draftId: id,
		expectedRevision: 1,
	});
	let draft = await getDraft(owner, id);
	await saveDraft(owner, {
		id,
		revision: draft.draft_revision,
		mailboxId: "mailbox",
		to: draft.to_addr,
		subject: "Human edited",
		text: "Changed",
		html: "<p>Changed</p>",
		cc: "",
		bcc: "",
	});
	expect(
		state.db
			.query(
				"SELECT revision,human_edited_at FROM agent_draft_metadata WHERE draft_id=?",
			)
			.get(id),
	).toMatchObject({ revision: 2, human_edited_at: expect.any(Number) });
	expect(
		(await getAgentSendRequest(owner, approval.data.approvalId)).stale,
	).toBe(true);
	expect(
		(
			await tool("discard_draft", {
				mailboxId: "mailbox",
				draftId: id,
				expectedRevision: 2,
			})
		).isError,
	).toBe(true);
	draft = await getDraft(owner, id);
	await uploadAttachments(
		owner,
		id,
		[new File(["x"], "human.txt")],
		draft.draft_revision,
	);
	expect(
		state.db
			.query("SELECT revision FROM agent_draft_metadata WHERE draft_id=?")
			.get(id),
	).toEqual({ revision: 3 });
	draft = await getDraft(owner, id);
	await removeAttachment(
		owner,
		id,
		draft.attachments[0]!.id,
		draft.draft_revision,
	);
	expect(
		state.db
			.query("SELECT revision FROM agent_draft_metadata WHERE draft_id=?")
			.get(id),
	).toEqual({ revision: 4 });
});
test("request_send never dispatches; only human confirmation sends once and retains review history", async () => {
	await configureEmail();
	const id = await createDraft(),
		approval = await tool("request_send", {
			mailboxId: "mailbox",
			draftId: id,
			expectedRevision: 1,
		});
	expect(approval.data).toMatchObject({
		status: "pending_approval",
		reviewUrl: expect.stringContaining("/agent/review/"),
	});
	expect(state.db.query("SELECT id FROM outbound_jobs").all()).toEqual([]);
	expect(
		(await tool("get_send_request", { approvalId: approval.data.approvalId }))
			.data.status,
	).toBe("pending");
	let sends = 0;
	const sent = await confirmAgentSend(
		owner,
		approval.data.approvalId,
		async () => {
			sends++;
			return Response.json({
				success: true,
				result: { message_id: "approved-send" },
			});
		},
	);
	expect(sent.status).toBe("sent");
	expect(sent.messageId).not.toBe(id);
	expect(sends).toBe(1);
	expect(
		state.db.query("SELECT status FROM messages WHERE id=?").get(id),
	).toEqual({ status: "trash" });
	expect(
		(await getAgentSendRequest(owner, approval.data.approvalId)).status,
	).toBe("sent");
	await confirmAgentSend(owner, approval.data.approvalId, async () => {
		throw Error("Must not resend");
	});
	expect(sends).toBe(1);
});
test("failed provider confirmation records unknown outcome and preserves the draft for reconciliation", async () => {
	await configureEmail();
	const id = await createDraft(),
		approval = await tool("request_send", {
			mailboxId: "mailbox",
			draftId: id,
			expectedRevision: 1,
		});
	await expect(
		confirmAgentSend(owner, approval.data.approvalId, async () =>
			Response.json(
				{ success: false, errors: [{ message: "Unavailable" }] },
				{ status: 503 },
			),
		),
	).rejects.toThrow("Delivery outcome needs review");
	expect(
		(await getAgentSendRequest(owner, approval.data.approvalId)).status,
	).toBe("unknown");
	expect((await getDraft(owner, id)).status).toBe("draft");
	expect(
		(
			await tool("request_send", {
				mailboxId: "mailbox",
				draftId: id,
				expectedRevision: 1,
			})
		).isError,
	).toBe(true);
});
test("approved future delivery stays local until cron, can be inspected and cancelled through MCP", async () => {
	const id = await createDraft(),
		date = new Date(Date.now() + 3600000).toISOString();
	await tool("update_draft", {
		mailboxId: "mailbox",
		draftId: id,
		expectedRevision: 1,
		scheduledAt: date,
	});
	const approval = await tool("request_send", {
		mailboxId: "mailbox",
		draftId: id,
		expectedRevision: 2,
	});
	const queued = await confirmAgentSend(
		owner,
		approval.data.approvalId,
		async () => {
			throw Error("Scheduled email must not send now");
		},
	);
	expect(queued.scheduled).toBe(true);
	const scheduled = await tool("get_scheduled_send", {
		mailboxId: "mailbox",
		messageId: queued.messageId,
	});
	expect(scheduled.data.scheduledAt).toBe(
		new Date(Math.floor(Date.parse(date) / 1000) * 1000).toISOString(),
	);
	const cancelled = await tool("cancel_scheduled_send", {
		mailboxId: "mailbox",
		messageId: queued.messageId,
	});
	expect(cancelled.data).toMatchObject({
		status: "cancelled",
		draftId: queued.messageId,
	});
	expect(state.db.query("SELECT id FROM outbound_jobs").all()).toEqual([]);
});
test("MCP request ownership and key revocation protect send reviews", async () => {
	const id = await createDraft(),
		approval = await tool("request_send", {
			mailboxId: "mailbox",
			draftId: id,
			expectedRevision: 1,
		}),
		other = (
			await createManagedKey(owner, "mcp", {
				name: "Other client",
				scopes: ["mcp:request-send"],
				mailboxIds: ["mailbox"],
			})
		).key;
	expect(
		(
			await tool(
				"get_send_request",
				{ approvalId: approval.data.approvalId },
				other,
			)
		).isError,
	).toBe(true);
	const principal = await authenticateMcpRequest(req({}));
	if (!principal) throw Error("auth");
	await revokeManagedKey(owner, "mcp", principal.keyId);
	expect(
		(await getAgentSendRequest(owner, approval.data.approvalId)).status,
	).toBe("cancelled");
	expect((await handleMcpRequest(req({}))).status).toBe(401);
});
test("MCP calendar tools preserve recurring schedules, free-time ranges and atomic owned-series operations", async () => {
	const event = await tool("create_event", {
		title: "Daily planning",
		startsAt: "2030-03-29T09:00:00+01:00",
		endsAt: "2030-03-29T10:00:00+01:00",
		timeZone: "Europe/Rome",
		repeat: "daily",
		attendees: ["guest@example.org"],
	});
	expect(event.data.status).toBe("created");
	expect(state.db.query("SELECT id FROM outbound_jobs").all()).toEqual([]);
	const schedule = await tool("get_schedule", {
		start: "2030-03-29T00:00:00Z",
		end: "2030-04-02T00:00:00Z",
	});
	expect(schedule.data.events).toHaveLength(4);
	expect(schedule.data.events[2].startsAt).toBe("2030-03-31T07:00:00.000Z");
	const occurrence = await tool("get_event", {
		eventId: schedule.data.events[2].id,
	});
	expect(occurrence.data.event.seriesId).toBe(event.data.eventId);
	const failed = await tool("update_events", {
		updates: [
			{ eventId: event.data.eventId, title: "Must roll back" },
			{ eventId: "missing", title: "Missing" },
		],
	});
	expect(failed.isError).toBe(true);
	expect(
		(await tool("get_event", { eventId: event.data.eventId })).data.event.title,
	).toBe("Daily planning");
	const free = await tool("find_free_time", {
		start: "2030-03-29T07:00:00Z",
		end: "2030-03-29T10:00:00Z",
		durationMinutes: 30,
	});
	expect(free.data.slots).toEqual([
		{
			startsAt: "2030-03-29T07:00:00.000Z",
			endsAt: "2030-03-29T08:00:00.000Z",
		},
		{
			startsAt: "2030-03-29T09:00:00.000Z",
			endsAt: "2030-03-29T10:00:00.000Z",
		},
	]);
	expect(
		(await tool("delete_events", { eventIds: [event.data.eventId] })).data
			.status,
	).toBe("deleted");
});
test("administrative MCP tools reuse creator-scoped v1 contracts and do not expose personal mail tools", async () => {
	const admin = (
		await createManagedKey(owner, "admin", {
			name: "MCP administration",
			scopes: ["storage", "mailboxes", "accounts"],
			mcpAllowed: true,
		})
	).key;
	expect(
		(await rpc("tools/list", {}, admin)).result.tools
			.map((item: { name: string }) => item.name)
			.sort(),
	).toEqual(["manage_accounts", "manage_mailboxes", "manage_storage"]);
	expect(
		(await tool("manage_storage", { action: "test" }, admin)).data,
	).toMatchObject({ status: 200, data: { ok: true } });
	expect(
		(await tool("manage_accounts", { action: "list" }, admin)).data.status,
	).toBe(403);
	enableTeamSharing(state.db);
	expect(
		(await tool("manage_accounts", { action: "list" }, admin)).data.status,
	).toBe(200);
	expect(
		(await tool("manage_mailboxes", { action: "get" }, admin)).data.error,
	).toBe("Mailbox id required");
	state.db.exec("UPDATE users SET role='user' WHERE id='owner'");
	expect((await handleMcpRequest(req({}, admin))).status).toBe(401);
});
test("native rate limiting retains the source 120-request minute and resets expired windows", () => {
	const id = crypto.randomUUID();
	for (let i = 0; i < 120; i++) expect(allowAgentRequest(id, 1000)).toBe(true);
	expect(allowAgentRequest(id, 1001)).toBe(false);
	expect(allowAgentRequest(id, 61000)).toBe(true);
});

test("two approvals cannot dispatch the same draft twice while a provider call is in flight", async () => {
	await configureEmail();
	const id = await createDraft(),
		first = await tool("request_send", {
			mailboxId: "mailbox",
			draftId: id,
			expectedRevision: 1,
		}),
		second = await tool("request_send", {
			mailboxId: "mailbox",
			draftId: id,
			expectedRevision: 1,
		}),
		started = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let calls = 0;
	const pending = confirmAgentSend(owner, first.data.approvalId, async () => {
		calls++;
		started.resolve();
		await release.promise;
		return Response.json({
			success: true,
			result: { message_id: "single-approved-delivery" },
		});
	});
	await started.promise;
	try {
		expect(
			(
				await confirmAgentSend(owner, first.data.approvalId, async () => {
					calls++;
					throw Error("Duplicate");
				})
			).status,
		).toBe("claimed");
		await expect(
			confirmAgentSend(owner, second.data.approvalId, async () => {
				calls++;
				throw Error("Duplicate");
			}),
		).rejects.toThrow("Draft not found");
		expect(state.db.query("SELECT id FROM outbound_jobs").all()).toHaveLength(
			1,
		);
	} finally {
		release.resolve();
		await pending;
	}
	expect(calls).toBe(1);
	expect((await getAgentSendRequest(owner, first.data.approvalId)).status).toBe(
		"sent",
	);
});

test("attachment digest changes and expired approvals cannot dispatch", async () => {
	const storage = new LocalStorage(),
		id = await createDraft();
	let draft = await getDraft(owner, id);
	await uploadAttachments(
		owner,
		id,
		[new File(["original"], "note.txt")],
		draft.draft_revision,
	);
	const approval = await tool("request_send", {
		mailboxId: "mailbox",
		draftId: id,
		expectedRevision: 2,
	});
	draft = await getDraft(owner, id);
	await storage.put(draft.attachments[0]!.r2_key, "modified");
	expect(
		(await getAgentSendRequest(owner, approval.data.approvalId)).stale,
	).toBe(true);
	await expect(
		confirmAgentSend(owner, approval.data.approvalId),
	).rejects.toThrow("Draft changed");
	await storage.put(draft.attachments[0]!.r2_key, "original");
	state.db
		.query("UPDATE agent_send_approvals SET expires_at=1 WHERE id=?")
		.run(approval.data.approvalId);
	await expect(
		confirmAgentSend(owner, approval.data.approvalId),
	).rejects.toThrow("Approval expired");
	expect(
		(await getAgentSendRequest(owner, approval.data.approvalId)).status,
	).toBe("expired");
	expect(state.db.query("SELECT id FROM outbound_jobs").all()).toEqual([]);
});

test("key revocation after attachment staging rolls back draft edits and removes the staged copy", async () => {
	const storage = new LocalStorage();
	await storage.put("inbound/source", "x");
	state.db.exec(
		"INSERT INTO message_attachments(id,message_id,filename,content_type,size,r2_key,created_at) VALUES('source','message','source.txt','text/plain',1,'inbound/source',1)",
	);
	const id = await createDraft(),
		original = LocalStorage.prototype.put,
		written: string[] = [];
	const put = spyOn(LocalStorage.prototype, "put").mockImplementation(
		async function (
			this: LocalStorage,
			...args: Parameters<LocalStorage["put"]>
		) {
			await original.apply(this, args);
			written.push(args[0]);
			state.db.exec("DELETE FROM api_keys WHERE kind='mcp'");
		},
	);
	try {
		const result = await tool("update_draft", {
			mailboxId: "mailbox",
			draftId: id,
			expectedRevision: 1,
			subject: "Must roll back",
			addAttachments: [{ sourceEmailId: "message", attachmentId: "source" }],
		});
		expect(result.isError).toBe(true);
	} finally {
		put.mockRestore();
	}
	expect((await getDraft(owner, id)).subject).toBe("MCP draft");
	expect(
		state.db
			.query("SELECT revision FROM agent_draft_metadata WHERE draft_id=?")
			.get(id),
	).toEqual({ revision: 1 });
	expect(written).toHaveLength(1);
	expect(await storage.file(written[0]!).exists()).toBe(false);
	expect(await storage.file("inbound/source").exists()).toBe(true);
});

test("MCP requests reject oversized and malformed JSON through the original SDK transport", async () => {
	const malformed = await handleMcpRequest(
		new Request("http://localhost:3000/mcp", {
			method: "POST",
			headers: {
				Authorization: "Bearer " + key,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: "{",
		}),
	);
	expect(malformed.status).toBe(400);
	const oversized = await handleMcpRequest(
		new Request("http://localhost:3000/mcp", {
			method: "POST",
			headers: {
				Authorization: "Bearer " + key,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: " ".repeat(4 * 1024 * 1024 + 1),
		}),
	);
	expect(oversized.status).toBe(413);
});

test("modern per-request discovery and tool calls retain the SDK protocol envelope", async () => {
	const _meta = {
		"io.modelcontextprotocol/protocolVersion": "2026-07-28",
		"io.modelcontextprotocol/clientCapabilities": {},
		"io.modelcontextprotocol/clientInfo": {
			name: "modern-fixture",
			version: "1",
		},
	};
	const discovery = await rpc("server/discover", { _meta }, key, {
		"MCP-Protocol-Version": "2026-07-28",
		"Mcp-Method": "server/discover",
	});
	expect(discovery.result.supportedVersions).toContain("2026-07-28");
	expect(discovery.result.capabilities).toHaveProperty("tools");
	const result = await rpc(
		"tools/call",
		{
			_meta,
			name: "list_mailboxes",
			arguments: {},
		},
		key,
		{
			"MCP-Protocol-Version": "2026-07-28",
			"Mcp-Method": "tools/call",
			"Mcp-Name": "list_mailboxes",
		},
	);
	expect(JSON.parse(result.result.content[0].text)).toEqual([
		{ id: "mailbox", address: "hello@example.com", displayName: null },
	]);
});

test("assistant draft metadata, scoped requests and review state survive full backup and restore", async () => {
	const id = await createDraft(),
		approval = await tool("request_send", {
			mailboxId: "mailbox",
			draftId: id,
			expectedRevision: 1,
		}),
		file = state.directory + "/agent-backup.json";
	await writeBackup(state.path, file);
	state.db.query("DELETE FROM messages WHERE id=?").run(id);
	expect(state.db.query("SELECT id FROM agent_send_approvals").all()).toEqual(
		[],
	);
	restoreBackup(state.db, await Bun.file(file).json());
	expect(
		await getAgentSendRequest(owner, approval.data.approvalId),
	).toMatchObject({ status: "pending", stale: false });
	expect(
		(await tool("get_send_request", { approvalId: approval.data.approvalId }))
			.data.status,
	).toBe("pending");
});

test("persisted approved jobs finish through the shared delivery path after the approval call has returned", async () => {
	await configureEmail();
	const id = await createDraft();
	await tool("update_draft", {
		mailboxId: "mailbox",
		draftId: id,
		expectedRevision: 1,
		scheduledAt: new Date(Date.now() + 3600000).toISOString(),
	});
	const approval = await tool("request_send", {
		mailboxId: "mailbox",
		draftId: id,
		expectedRevision: 2,
	});
	const queued = await confirmAgentSend(owner, approval.data.approvalId);
	state.db.exec("UPDATE outbound_jobs SET scheduled_at=0");
	const job = state.db
		.query<{ id: string }, []>("SELECT id FROM outbound_jobs")
		.get()!;
	await deliverJob(job.id, async () =>
		Response.json({
			success: true,
			result: { message_id: "cron-approved-send" },
		}),
	);
	expect(
		state.db
			.query("SELECT status FROM messages WHERE id=?")
			.get(queued.messageId),
	).toEqual({ status: "sent" });
	expect(
		(await getAgentSendRequest(owner, approval.data.approvalId)).status,
	).toBe("sent");
	expect(
		state.db.query("SELECT status FROM messages WHERE id=?").get(id),
	).toEqual({ status: "trash" });
});

test("calendar-only keys need no mailbox grants and keep personal calendar ownership and write scopes separate", async () => {
	const calendarOnly = (
		await createManagedKey(stranger, "mcp", {
			name: "Calendar only",
			scopes: ["mcp:calendar-read", "mcp:calendar-write"],
			mailboxIds: [],
		})
	).key;
	const event = await tool(
		"create_event",
		{
			title: "Private event",
			startsAt: "2030-01-01T09:00:00Z",
			endsAt: "2030-01-01T10:00:00Z",
		},
		calendarOnly,
	);
	expect(event.data.status).toBe("created");
	expect(
		(await tool("get_event", { eventId: event.data.eventId })).isError,
	).toBe(true);
	expect((await tool("list_mailboxes", {}, calendarOnly)).isError).toBe(true);
	const reader = (
		await createManagedKey(stranger, "mcp", {
			name: "Calendar reader",
			scopes: ["mcp:calendar-read"],
			mailboxIds: [],
		})
	).key;
	expect(
		(await tool("get_event", { eventId: event.data.eventId }, reader)).data
			.event.title,
	).toBe("Private event");
	expect(
		(await tool("delete_events", { eventIds: [event.data.eventId] }, reader))
			.isError,
	).toBe(true);
});

test("MCP response completion and cancellation release the request-owned abort listener", async () => {
	for (const cancel of [false, true]) {
		const request = req({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/list",
				params: {},
			}),
			signal = request.signal,
			add = spyOn(signal, "addEventListener"),
			remove = spyOn(signal, "removeEventListener");
		try {
			const response = await handleMcpRequest(request);
			expect(response.status).toBe(200);
			const listener = add.mock.calls.find(([event]) => event === "abort")?.[1];
			expect(listener).toBeDefined();
			if (cancel) await response.body!.cancel();
			else await response.text();
			expect(
				remove.mock.calls.some(
					([event, callback]) => event === "abort" && callback === listener,
				),
			).toBe(true);
		} finally {
			add.mockRestore();
			remove.mockRestore();
		}
	}
});

test("MCP keeps the original framework HEAD authentication and automatic OPTIONS behavior", async () => {
	const options = await handleMcpRequest(
		new Request("http://localhost:3000/mcp", { method: "OPTIONS" }),
	);
	expect(options.status).toBe(204);
	expect(options.headers.get("allow")).toBe("DELETE, GET, HEAD, OPTIONS, POST");
	expect(await options.text()).toBe("");
	const anonymous = await handleMcpRequest(
		new Request("http://localhost:3000/mcp", { method: "HEAD" }),
	);
	expect(anonymous.status).toBe(401);
	expect(anonymous.headers.get("www-authenticate")).toBe("Bearer");
	const head = await handleMcpRequest(req(undefined, key, "HEAD"));
	expect(head.status).toBe(405);
	expect(await head.text()).toBe("");
});

test("get_email returns a coherent body and assistant revision while another process edits the draft", async () => {
	const id = await createDraft();
	state.db.query("UPDATE messages SET text_body=? WHERE id=?").run("1", id);
	const script = state.directory + "/concurrent-agent-writer.ts";
	await Bun.write(
		script,
		`
  import {Database} from 'bun:sqlite';
  const db=new Database(process.argv[2]!);db.exec('PRAGMA busy_timeout=5000');
  const body=db.query('UPDATE messages SET text_body=?,draft_revision=? WHERE id=?');
  const revision=db.query('UPDATE agent_draft_metadata SET revision=? WHERE draft_id=?');
  const change=db.transaction((n:number)=>{body.run(String(n),n,process.argv[3]!);revision.run(n,process.argv[3]!)});
  console.log('ready');
  try{for(let n=2;n<1000;n++){change(n);await Bun.sleep(1)}}finally{db.close()}
 `,
	);
	const writer = Bun.spawn([process.execPath, script, state.path, id], {
			stdout: "pipe",
			stderr: "pipe",
		}),
		errors = new Response(writer.stderr).text();
	try {
		const reader = writer.stdout.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toContain(
			"ready",
		);
		reader.releaseLock();
		const versions = new Set<number>();
		for (let index = 0; index < 60; index++) {
			const result = z
				.object({ text: z.string(), revision: z.number() })
				.parse(
					await runEmailTool(
						{ user: owner, mailboxId: "mailbox", origin: "mcp" },
						"get_email",
						{ emailId: id },
					),
				);
			expect(result.text).toBe(String(result.revision));
			versions.add(result.revision);
		}
		expect(versions.size).toBeGreaterThan(1);
	} finally {
		writer.kill();
		await writer.exited;
		await errors;
	}
});
