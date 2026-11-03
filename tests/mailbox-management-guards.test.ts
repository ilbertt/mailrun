import { test, expect, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import { fixture } from "./fixtures";
import {
	prepareMailboxManagement,
	mailboxManagementActor,
	mailboxManagementRequest,
} from "./mailbox-management-fixture";
import { dispatchMailApi } from "../src/server/api/mail";
import { listMailboxes, getThread } from "../src/server/mail/repository";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
	await prepareMailboxManagement(state.db, state.directory, {
		name: "guard",
		method: "GET",
		path: "/api/mailboxes",
	});
});
afterEach(async () => {
	await state.close();
});
const actor = () =>
	mailboxManagementActor(state.db, {
		name: "guard",
		method: "GET",
		path: "/api/mailboxes",
	});
const request = (
	path: string,
	method: "POST" | "GET" | "DELETE",
	fields?: Record<string, unknown>,
) =>
	mailboxManagementRequest(
		{ name: "guard", path, method, fields },
		"https://mailboxes-fixture.example",
	);
test("legacy unknown grants retain source metadata without authorizing messages", async () => {
	state.db.exec(
		"UPDATE mailbox_access SET permission='unknown' WHERE id='borrowed-share';INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,text_body,created_at) VALUES('borrowed-message','stranger','borrowed','inbound','sender@example.net','borrowed@foreign.example','Private','Private body',1)",
	);
	const response = await dispatchMailApi(
		request("/api/mailboxes", "GET"),
		actor(),
	);
	expect(
		(await response.json()).mailboxes.find(
			(row: { id: string }) => row.id === "borrowed",
		).permission,
	).toBe("unknown");
	expect(
		(await listMailboxes(actor())).some((row) => row.id === "borrowed"),
	).toBe(false);
	await expect(getThread(actor(), "borrowed-message")).rejects.toThrow(
		"Message not found",
	);
	await expect(
		dispatchMailApi(request("/api/mailboxes/borrowed", "GET"), actor()),
	).rejects.toMatchObject({ status: 404 });
});
test("sharing rechecks the current administrator at publication", async () => {
	state.db.exec(
		"UPDATE users SET is_primary_admin=0 WHERE id='owner';CREATE TRIGGER revoke_share_admin AFTER UPDATE OF updated_at ON app_settings BEGIN UPDATE users SET role='user' WHERE id='owner';END",
	);
	await expect(
		dispatchMailApi(
			request("/api/mailboxes/mailbox/access", "POST", {
				userId: "child",
				permission: "full_access",
			}),
			actor(),
		),
	).rejects.toMatchObject({ status: 403 });
	expect(
		state.db
			.query("SELECT id FROM mailbox_access WHERE mailbox_id='mailbox'")
			.all(),
	).toEqual([]);
});
test("sharing rechecks Team entitlement at publication", async () => {
	state.db.exec(
		"CREATE TRIGGER revoke_share_license AFTER UPDATE OF updated_at ON app_settings BEGIN UPDATE license_settings SET state='expired';END",
	);
	await expect(
		dispatchMailApi(
			request("/api/mailboxes/mailbox/access", "POST", {
				userId: "child",
				permission: "full_access",
			}),
			actor(),
		),
	).rejects.toMatchObject({ status: 403 });
	expect(
		state.db
			.query("SELECT id FROM mailbox_access WHERE mailbox_id='mailbox'")
			.all(),
	).toEqual([]);
});
test("deletion rechecks current ownership-management rights before changing data", async () => {
	state.db.exec(
		"UPDATE users SET is_primary_admin=0 WHERE id='owner';CREATE TRIGGER revoke_delete_admin AFTER UPDATE OF updated_at ON app_settings BEGIN UPDATE users SET role='user' WHERE id='owner';END",
	);
	await expect(
		dispatchMailApi(request("/api/mailboxes/mailbox", "DELETE"), actor()),
	).rejects.toMatchObject({ status: 403 });
	expect(
		state.db.query("SELECT id FROM mailboxes WHERE id='mailbox'").get(),
	).toEqual({ id: "mailbox" });
	expect(
		state.db
			.query("SELECT mailbox_id FROM messages WHERE id='stored-message'")
			.get(),
	).toEqual({ mailbox_id: "mailbox" });
});
test("independent mailbox and alias creation reserve one literal address", async () => {
	const createModule = new URL(
		"../src/server/mail/mailbox-management.ts",
		import.meta.url,
	).pathname;
	const aliasModule = new URL(
		"../src/server/mail/management.ts",
		import.meta.url,
	).pathname;
	const installation = new URL(
		"../src/server/cloudflare/installation.ts",
		import.meta.url,
	).pathname;
	for (let round = 0; round < 4; round++) {
		const local = "concurrent-" + round,
			operations = [
				`await createMailbox(user,{domainId:'domain',localPart:${JSON.stringify(local)}})`,
				`await addAlias(user,{mailboxId:'owned-z',domainId:'domain',localPart:${JSON.stringify(local)}})`,
			];
		const children = operations.map((operation) =>
			Bun.spawn(
				[
					process.execPath,
					"-e",
					`import {createMailbox} from ${JSON.stringify(createModule)};import {addAlias} from ${JSON.stringify(aliasModule)};import {getInstallation} from ${JSON.stringify(installation)};const user=${JSON.stringify(actor())};await getInstallation();console.log('ready');await Bun.stdin.text();try{${operation};console.log(JSON.stringify({status:200}));}catch(error){console.log(JSON.stringify({status:error instanceof Response?error.status:500,error:error instanceof Response?await error.text():error.message}));}`,
				],
				{
					cwd: process.cwd(),
					env: {
						PATH: process.env.PATH,
						HOME: process.env.HOME,
						TMPDIR: process.env.TMPDIR,
						DATA_DIR: state.directory,
					},
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
					timeout: 8000,
					killSignal: "SIGKILL",
				},
			),
		);
		const errors = children.map((child) => new Response(child.stderr).text());
		try {
			await Promise.all(
				children.map(async (child) => {
					const reader = child.stdout.getReader();
					try {
						let text = "";
						while (!text.includes("ready\n")) {
							const part = await reader.read();
							if (part.done)
								throw new Error("Reservation writer exited before barrier");
							text += new TextDecoder().decode(part.value);
						}
					} finally {
						reader.releaseLock();
					}
				}),
			);
			for (const child of children) child.stdin.end();
			const replies = await Promise.all(
				children.map(async (child) => {
					const reader = child.stdout.getReader();
					try {
						let text = "";
						for (;;) {
							const part = await reader.read();
							if (part.done)
								return z
									.object({ status: z.number(), error: z.string().optional() })
									.parse(JSON.parse(text));
							text += new TextDecoder().decode(part.value);
						}
					} finally {
						reader.releaseLock();
					}
				}),
			);
			expect(await Promise.all(children.map((child) => child.exited))).toEqual([
				0, 0,
			]);
			expect(replies.map((row) => row.status).sort()).toEqual([200, 409]);
			expect(
				state.db
					.query(
						"SELECT (SELECT count(*) FROM mailboxes WHERE domain_id='domain' AND local_part=?)+(SELECT count(*) FROM mailbox_aliases WHERE domain_id='domain' AND local_part=?) AS n",
					)
					.get(local, local),
			).toEqual({ n: 1 });
		} finally {
			for (const child of children) child.kill();
			await Promise.all(children.map((child) => child.exited));
			for (const error of await Promise.all(errors)) expect(error).toBe("");
		}
	}
}, 15000);
