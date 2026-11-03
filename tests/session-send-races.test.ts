import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { fixture, owner, stranger } from "./fixtures";
import { prepareSendFixture, sendFields } from "./send-contract-fixture";
import { sessionSendApi } from "../src/server/api/session-send";
import { cancelSessionSend } from "../src/server/mail/session-send";
import { saveDraft, deleteDraft, getDraft } from "../src/server/mail/drafts";
import { LocalStorage } from "../src/server/storage";
import { z } from "zod";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
	await prepareSendFixture(state.db, state.directory, {
		name: "race",
		kind: "send",
	});
});
afterEach(async () => {
	await state.close();
});
function submit(
	body: Record<string, unknown>,
	revision?: number,
	user = owner,
) {
	return sessionSendApi(
		new Request("https://send-fixture.example/api/send", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(revision === undefined ? {} : { "If-Match": `"${revision}"` }),
			},
			body: JSON.stringify(body),
		}),
		user,
	);
}
test("source send creates an immutable scheduled copy that survives editing and deleting the original draft", async () => {
	const response = await submit(
		{ ...sendFields, draftId: "draft", scheduledAt: "2099-01-01T00:00:00Z" },
		0,
	);
	if (!response) throw new Error("No response");
	expect(response.status).toBe(200);
	const queued = z
		.object({ messageId: z.string() })
		.parse(await response.json());
	expect(queued.messageId).not.toBe("draft");
	expect(response.headers.get("X-Mailflare-Draft-Revision")).toBe("1");
	const edited = await saveDraft(owner, {
		mailboxId: "mailbox",
		from: "hello@example.com",
		to: "changed@example.net",
		subject: "Changed",
		text: "New edit",
		id: "draft",
		revision: 1,
	});
	await deleteDraft(owner, "draft", edited.draft_revision);
	expect(
		state.db
			.query("SELECT status,text_body FROM messages WHERE id=?")
			.get(queued.messageId),
	).toEqual({ status: "queued", text_body: sendFields.text });
	const file = z
		.object({ r2_key: z.string() })
		.parse(
			state.db
				.query("SELECT r2_key FROM message_attachments WHERE message_id=?")
				.get(queued.messageId),
		);
	expect(await new LocalStorage().file(file.r2_key).text()).toBe("stored");
	expect(await new LocalStorage().file("stored.txt").exists()).toBe(false);
});
test("competing submissions of the same draft revision queue one copy", async () => {
	const responses = await Promise.all(
		[0, 1].map(() =>
			submit(
				{
					...sendFields,
					draftId: "draft",
					scheduledAt: "2099-01-01T00:00:00Z",
				},
				0,
			),
		),
	);
	expect(responses.map((r) => r?.status).sort()).toEqual([200, 409]);
	expect(
		state.db
			.query(
				"SELECT count(*) AS count FROM outbound_jobs WHERE id!='scheduled-job'",
			)
			.get(),
	).toEqual({ count: 1 });
});
test("a submitted draft keeps its version fence so late composer cleanup cannot discard a newer edit", async () => {
	const response = await submit(
		{ ...sendFields, draftId: "draft", scheduledAt: "2099-01-01T00:00:00Z" },
		0,
	);
	if (!response) throw new Error("No response");
	expect(response.status).toBe(200);
	const submitted = Number(response.headers.get("X-Mailflare-Draft-Revision"));
	await saveDraft(owner, {
		...sendFields,
		id: "draft",
		revision: submitted,
		text: "A newer edit",
	});
	await expect(deleteDraft(owner, "draft", submitted)).rejects.toThrow(
		"another tab",
	);
	expect((await getDraft(owner, "draft")).text_body).toBe("A newer edit");
});
test("revoking a shared sender while files are copied prevents queue publication and removes staged copies", async () => {
	await prepareSendFixture(state.db, state.directory, {
		name: "revoked",
		kind: "send",
		actor: "stranger",
		permission: "send_as",
	});
	const original = LocalStorage.prototype.put;
	let copied = false;
	const put = spyOn(LocalStorage.prototype, "put").mockImplementation(
		async function (this: LocalStorage, key, body) {
			await original.call(this, key, body);
			if (key.startsWith("attachments/")) {
				copied = true;
				state.db.exec("DELETE FROM mailbox_access WHERE user_id='stranger'");
			}
		},
	);
	try {
		const form = new FormData();
		for (const [key, value] of Object.entries(sendFields))
			form.append(key, String(value));
		form.append("scheduledAt", "2099-01-01T00:00:00Z");
		form.append(
			"attachments",
			new File(["new file"], "new.txt", { type: "text/plain" }),
		);
		const response = await sessionSendApi(
			new Request("https://send-fixture.example/api/send", {
				method: "POST",
				body: form,
			}),
			stranger,
		);
		expect(copied).toBe(true);
		expect(response?.status).toBe(403);
		expect(
			state.db
				.query(
					"SELECT count(*) AS count FROM messages WHERE id NOT IN('draft','scheduled')",
				)
				.get(),
		).toEqual({ count: 0 });
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
});
test("a separate delivery process that claimed a scheduled job wins over cancellation", async () => {
	state.db.exec(
		"UPDATE outbound_jobs SET scheduled_at=0 WHERE id='scheduled-job'",
	);
	const gate = Promise.withResolvers<void>(),
		entered = Promise.withResolvers<void>();
	let calls = 0;
	const endpoint = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch() {
			calls++;
			entered.resolve();
			await gate.promise;
			return Response.json({
				success: true,
				result: { message_id: "<race@example.net>" },
			});
		},
	});
	const module = new URL("../src/server/mail/send.ts", import.meta.url)
		.pathname;
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			`import {deliverJob} from ${JSON.stringify(module)};await deliverJob('scheduled-job',(_input,init)=>fetch(${JSON.stringify(endpoint.url.href)},init));`,
		],
		{
			cwd: process.cwd(),
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				TMPDIR: process.env.TMPDIR,
				DATA_DIR: state.directory,
			},
			stdout: "pipe",
			stderr: "pipe",
			timeout: 10000,
			killSignal: "SIGKILL",
		},
	);
	const errors = new Response(child.stderr).text();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			entered.promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Delivery did not reach provider")),
					5000,
				);
			}),
		]);
		clearTimeout(timer);
		let failure: unknown;
		try {
			await cancelSessionSend(owner, "scheduled");
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Response);
		if (!(failure instanceof Response))
			throw new Error("Missing cancellation error");
		expect(failure.status).toBe(409);
		expect(await failure.text()).toBe("This message is not scheduled");
		gate.resolve();
		expect(await child.exited).toBe(0);
		expect(calls).toBe(1);
		expect(
			state.db.query("SELECT status FROM messages WHERE id='scheduled'").get(),
		).toEqual({ status: "sent" });
	} finally {
		clearTimeout(timer);
		gate.resolve();
		await child.exited;
		await endpoint.stop(true);
		const log = await errors;
		if (log) console.error(log);
	}
});
test("cancelling first removes the job before an independent delivery process can claim it", async () => {
	state.db.exec(
		"UPDATE outbound_jobs SET scheduled_at=0 WHERE id='scheduled-job'",
	);
	await cancelSessionSend(owner, "scheduled");
	const module = new URL("../src/server/mail/send.ts", import.meta.url)
		.pathname;
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			`import {deliverJob} from ${JSON.stringify(module)};await deliverJob('scheduled-job',()=>{throw new Error('Cancelled delivery reached the provider');});`,
		],
		{
			cwd: process.cwd(),
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				TMPDIR: process.env.TMPDIR,
				DATA_DIR: state.directory,
			},
			stdout: "pipe",
			stderr: "pipe",
			timeout: 10000,
			killSignal: "SIGKILL",
		},
	);
	const errors = await new Response(child.stderr).text();
	expect(await child.exited).toBe(0);
	expect(errors).toBe("");
	expect(
		state.db.query("SELECT status FROM messages WHERE id='scheduled'").get(),
	).toEqual({ status: "draft" });
});
