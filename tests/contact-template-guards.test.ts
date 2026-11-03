import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { fixture, owner, stranger } from "./fixtures";
import { prepare } from "./contacts-templates-fixture";
import { contactsApi } from "../src/server/api/contacts";
import { templatesApi } from "../src/server/api/templates";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
	await prepare(state.db, state.directory, {
		name: "guard",
		path: "/api/templates",
		method: "GET",
	});
});
afterEach(async () => {
	await state.close();
});
test("deleting an imported template retains objects still referenced by another message", async () => {
	state.db.exec(
		"UPDATE messages SET raw_r2_key='raw-template' WHERE id='not-template'; UPDATE messages SET raw_r2_key='active-template-file' WHERE id='template-a'",
	);
	const response = await templatesApi(
		new Request("https://mail.example/api/templates/template", {
			method: "DELETE",
		}),
		owner,
	);
	expect(response?.status).toBe(200);
	expect(
		state.db.query("SELECT id FROM messages WHERE id='template'").get(),
	).toBeNull();
	expect(
		state.db
			.query("SELECT id FROM message_attachments WHERE message_id='template'")
			.all(),
	).toEqual([]);
	for (const key of ["raw-template", "active-template-file"])
		expect(await Bun.file(join(state.directory, "blobs", key)).text()).toBe(
			key,
		);
	expect(
		await Bun.file(
			join(state.directory, "blobs/trashed-template-file"),
		).exists(),
	).toBe(false);
});
test("blocking rolls back the contact and avatar job if publishing the rule fails", async () => {
	state.db.exec(
		"CREATE TRIGGER synthetic_reject_rule BEFORE INSERT ON routing_rules BEGIN SELECT RAISE(ABORT,'Synthetic rule publication failure'); END",
	);
	const before = state.db
		.query("SELECT * FROM mailrun_contact_avatar_jobs ORDER BY contact_id")
		.all();
	await expect(
		contactsApi(
			new Request("https://mail.example/api/contacts/block", {
				method: "POST",
				body: JSON.stringify({
					mailboxId: "mailbox",
					address: "new@example.net",
				}),
			}),
			owner,
		),
	).rejects.toThrow("Synthetic rule publication failure");
	expect(
		state.db
			.query("SELECT * FROM contacts WHERE email='new@example.net'")
			.get(),
	).toBeNull();
	expect(state.db.query("SELECT * FROM routing_rules").all()).toEqual([]);
	expect(
		state.db
			.query("SELECT * FROM mailrun_contact_avatar_jobs ORDER BY contact_id")
			.all(),
	).toEqual(before);
});

test("a permission downgrade at publication formats the template on behalf of the mailbox", async () => {
	state.db.exec(
		"INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES('template-share','mailbox','stranger','send_as',1); CREATE TRIGGER synthetic_template_downgrade AFTER UPDATE OF updated_at ON app_settings BEGIN UPDATE mailbox_access SET permission='send_on_behalf' WHERE id='template-share'; END",
	);
	const response = await templatesApi(
		new Request("https://mail.example/api/templates", {
			method: "POST",
			body: JSON.stringify({
				mailboxId: "mailbox",
				from: "hello@example.com",
				title: "Permission change",
				text: "Content",
			}),
		}),
		{ ...stranger, name: "Stale session name" },
	);
	expect(response?.status).toBe(201);
	expect(
		state.db
			.query("SELECT from_addr FROM messages WHERE subject='Permission change'")
			.get(),
	).toEqual({
		from_addr: '"Stranger on behalf of Shared Inbox" <hello@example.com>',
	});
});
