import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { fixture } from "./fixtures";
import {
	prepareV1Send,
	v1SendRequest,
	V1_SEND_FIELDS,
	V1_TOKEN,
} from "./v1-send-fixture";
import { serveV1Api } from "../src/server/api/v1";
import { LocalStorage } from "../src/server/storage";
import {
	authenticateMcpRequest,
	requireMcpScope,
} from "../src/server/mcp/auth";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
for (const [name, mutation] of [
	["deleted key", "DELETE FROM api_keys"],
	["removed send scope", "UPDATE api_keys SET scopes='[\"read\"]'"],
	["removed mailbox scope", "DELETE FROM mcp_key_mailboxes"],
	["disabled account", "UPDATE users SET disabled=1 WHERE id='owner'"],
] as const)
	test(
		"public send rejects " + name + " during attachment publication",
		async () => {
			const sample = {
				name,
				fields: {
					...V1_SEND_FIELDS,
					scheduledAt: "2099-01-01T00:00:00Z",
					attachments: [
						{ filename: "note.txt", contentBase64: btoa("Private attachment") },
					],
				},
			};
			await prepareV1Send(state.db, state.directory, sample);
			const original = LocalStorage.prototype.put;
			let copied = false;
			const put = spyOn(LocalStorage.prototype, "put").mockImplementation(
				async function (this: LocalStorage, key, body) {
					await original.call(this, key, body);
					if (key.startsWith("attachments/")) {
						copied = true;
						state.db.exec(mutation);
					}
				},
			);
			try {
				const response = await serveV1Api(
					v1SendRequest(sample, "https://v1-send-fixture.example"),
				);
				expect(copied).toBe(true);
				expect(response.status).toBe(401);
				expect(await response.json()).toEqual({ error: "Unauthorized" });
				for (const table of [
					"messages",
					"outbound_jobs",
					"message_attachments",
					"mailrun_outbound_snapshots",
				])
					expect(
						state.db.query("SELECT count(*) AS total FROM " + table).get(),
					).toEqual({ total: 0 });
				const keys = [];
				for await (const key of new Bun.Glob("**/*").scan({
					cwd: state.directory + "/blobs",
					onlyFiles: true,
				}))
					keys.push(key);
				expect(keys).toEqual(["stored.txt"]);
			} finally {
				put.mockRestore();
			}
		},
	);
test("MCP checks explicit mailbox grants live even when a legacy key has its flag off", async () => {
	await prepareV1Send(state.db, state.directory, {
		name: "mcp-live-legacy",
		kind: "mcp",
		scopes: ["mcp:read"],
		fields: V1_SEND_FIELDS,
	});
	state.db.exec("UPDATE api_keys SET mailbox_scope_enabled=0");
	const principal = await authenticateMcpRequest(
		new Request("https://v1-send-fixture.example/api/mcp", {
			headers: { Authorization: "Bearer " + V1_TOKEN },
		}),
	);
	expect(principal?.mailboxIds).toEqual(["mailbox"]);
	if (!principal) throw new Error("Missing MCP fixture principal");
	state.db.exec("DELETE FROM mcp_key_mailboxes");
	await expect(
		requireMcpScope(principal, "mcp:read", "mailbox"),
	).rejects.toMatchObject({ status: 401 });
});
