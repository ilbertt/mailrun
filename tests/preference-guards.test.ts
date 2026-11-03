import { test, expect, beforeEach, afterEach } from "bun:test";
import { fixture, owner } from "./fixtures";
import { preparePreferences, preferenceRequest } from "./preferences-fixture";
import { settingsApi } from "../src/server/api/settings";
import { listCalendarEvents } from "../src/server/calendar/events";
import { expandToolEvents } from "../src/lib/calendar/tool-occurrences";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
	await preparePreferences(state.db, state.directory, {
		name: "guard",
		path: "/api/settings/profile",
		method: "PATCH",
	});
});
afterEach(async () => {
	await state.close();
});
const request = (path: string, fields: Record<string, unknown>) =>
	preferenceRequest(
		{ name: "guard", path, method: "PATCH", fields },
		"https://preferences-fixture.example",
	);
test("changing the preferred timezone preserves legacy daily instants across DST", async () => {
	state.db.exec(
		"UPDATE calendar_events SET starts_at=1793365200,ends_at=1793368800 WHERE id='daily'",
	);
	const start = new Date("2026-10-30T00:00:00Z"),
		end = new Date("2026-11-04T00:00:00Z");
	const before = (await listCalendarEvents(owner, start, end)).filter(
		(event) => event.id === "daily",
	);
	const expected = expandToolEvents(
		before.map((event) => ({
			...event,
			timeZone: event.timeZone ?? "America/New_York",
		})),
		start,
		end,
	).map((event) => event.startsAt);
	expect(expected.length).toBeGreaterThan(2);
	const response = await settingsApi(
		request("/api/settings/time-zone", { timeZone: "Asia/Tokyo" }),
		owner,
	);
	expect(response?.status).toBe(200);
	const after = (await listCalendarEvents(owner, start, end)).filter(
		(event) => event.id === "daily",
	);
	expect(after[0]?.timeZone).toBe("America/New_York");
	expect(
		expandToolEvents(after, start, end).map((event) => event.startsAt),
	).toEqual(expected);
});
test("a failed account timezone update rolls back legacy-series freezing", async () => {
	state.db.exec(
		"CREATE TRIGGER synthetic_timezone_failure BEFORE UPDATE OF time_zone ON users BEGIN SELECT RAISE(ABORT,'Synthetic timezone failure');END",
	);
	const before = state.db
		.query("SELECT * FROM calendar_events ORDER BY id")
		.all();
	await expect(
		settingsApi(
			request("/api/settings/time-zone", { timeZone: "Asia/Tokyo" }),
			owner,
		),
	).rejects.toThrow("Synthetic timezone failure");
	expect(
		state.db.query("SELECT * FROM calendar_events ORDER BY id").all(),
	).toEqual(before);
	expect(
		state.db.query("SELECT time_zone FROM users WHERE id='owner'").get(),
	).toEqual({ time_zone: "America/New_York" });
});
test("a failed profile write rolls back the account, mailboxes and synchronized contacts", async () => {
	const before = {
		users: state.db.query("SELECT * FROM users ORDER BY id").all(),
		boxes: state.db.query("SELECT * FROM mailboxes ORDER BY id").all(),
		contacts: state.db.query("SELECT * FROM contacts ORDER BY id").all(),
	};
	state.db.exec(
		"CREATE TRIGGER synthetic_profile_failure BEFORE UPDATE OF reset_email ON users BEGIN SELECT RAISE(ABORT,'Synthetic profile failure');END",
	);
	await expect(
		settingsApi(
			request("/api/settings/profile", {
				name: "New profile",
				resetEmail: "new@example.net",
			}),
			owner,
		),
	).rejects.toThrow("Synthetic profile failure");
	expect({
		users: state.db.query("SELECT * FROM users ORDER BY id").all(),
		boxes: state.db.query("SELECT * FROM mailboxes ORDER BY id").all(),
		contacts: state.db.query("SELECT * FROM contacts ORDER BY id").all(),
	}).toEqual(before);
});
test("forwarding rechecks the license in the publication transaction", async () => {
	state.db.exec(
		"CREATE TRIGGER synthetic_forwarding_downgrade AFTER UPDATE OF updated_at ON app_settings BEGIN UPDATE license_settings SET state='expired';END",
	);
	await expect(
		settingsApi(
			request("/api/settings/forwarding", {
				forwardingEmail: "new@example.net",
			}),
			owner,
		),
	).rejects.toMatchObject({ status: 403 });
	expect(
		state.db.query("SELECT forwarding_email FROM users WHERE id='owner'").get(),
	).toEqual({ forwarding_email: "old@forward.example" });
});

test("independent Bun processes reserve one automatic reply for the same recipient", async () => {
	const { prepareAutoReply, autoReplyInput, autoReplySamples } = await import(
		"./auto-reply-fixture"
	);
	await prepareAutoReply(state.db, state.directory, autoReplySamples[0]!);
	const module = new URL("../src/server/mail/auto-reply.ts", import.meta.url)
		.pathname;
	const installation = new URL(
		"../src/server/cloudflare/installation.ts",
		import.meta.url,
	).pathname;
	const program = `import {queueAutoReply} from ${JSON.stringify(module)};import {getInstallation} from ${JSON.stringify(installation)};await getInstallation();console.log('ready');await Bun.stdin.text();const result=await queueAutoReply(${JSON.stringify(autoReplyInput(autoReplySamples[0]!))});console.log(JSON.stringify({queued:!!result}));`;
	const children = Array.from({ length: 2 }, () =>
		Bun.spawn([process.execPath, "-e", program], {
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
		}),
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
							throw new Error("Automatic reply writer exited before barrier");
						text += new TextDecoder().decode(part.value);
					}
				} finally {
					reader.releaseLock();
				}
			}),
		);
		for (const child of children) {
			child.stdin.write("go");
			child.stdin.end();
		}
		const replies = await Promise.all(
			children.map(async (child) => {
				const reader = child.stdout.getReader();
				try {
					let text = "";
					for (;;) {
						const part = await reader.read();
						if (part.done) return text;
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
		expect(
			replies.map((text) => JSON.parse(text).queued).filter(Boolean),
		).toHaveLength(1);
		expect(
			state.db
				.query("SELECT count(*) AS n FROM outbound_jobs WHERE status='queued'")
				.get(),
		).toEqual({ n: 1 });
	} finally {
		for (const child of children) child.kill();
		await Promise.all(children.map((child) => child.exited));
		const logs = await Promise.all(errors);
		for (const log of logs) expect(log).toBe("");
	}
}, 10000);
