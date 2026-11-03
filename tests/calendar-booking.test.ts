import { test, expect, beforeEach, afterEach } from "bun:test";
import bcrypt from "bcryptjs";
import { join } from "node:path";
import { fixture, owner, stranger, enableTeamSharing } from "./fixtures";
import { calendarInputSchema } from "../src/server/calendar/contracts";
import {
	createCalendarEvent,
	updateCalendarEvent,
	deleteCalendarEvent,
	listCalendarEvents,
} from "../src/server/calendar/events";
import { deliverInvitations } from "../src/server/calendar/invitations";
import {
	saveBookingEvent,
	listBookingEvents,
	loadPublicBookingEvent,
	bookingSlots,
	reserveBooking,
	ensureBookingUsername,
	updateBookingUsername,
} from "../src/server/calendar/booking";
import { slotFromLocalDate } from "../src/lib/booking/utils";
import {
	repeatsDuring,
	availableBookingSlots,
	bookingSlotAtStart,
} from "../src/lib/booking/availability";
import { expandCalendarEvents } from "../src/app/(calendar)/calendar/utils";
import { authenticateApiKey } from "../src/server/auth/api-key";
import { calendarApi } from "../src/server/api/calendar";
import { publicBookingApi } from "../src/server/api/booking";
import { LocalStorage } from "../src/server/storage";
import { restoreBackup, writeBackup } from "../src/lib/backups/export";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
const instant = (value: string) => new Date(value);
const input = (overrides: Record<string, unknown> = {}) =>
	calendarInputSchema.parse({
		title: "Planning",
		startsAt: "2030-01-07T09:00:00Z",
		endsAt: "2030-01-07T10:00:00Z",
		timeZone: "UTC",
		...overrides,
	});
const booking = (overrides: Record<string, unknown> = {}) => ({
	name: "Project review",
	slug: "project-review",
	description: "Bring the plan",
	color: "#2563eb",
	hostIds: ["owner"],
	durationMinutes: 30,
	location: "Meeting room",
	weekdays: [0, 1, 2, 3, 4, 5, 6],
	startTime: "09:00",
	endTime: "17:00",
	timeRanges: [{ startTime: "09:00", endTime: "17:00" }],
	timeZone: "UTC",
	enabled: true,
	...overrides,
});
const guest = {
	name: "A Guest",
	email: "guest@example.net",
	guestEmails: ["colleague@example.net"],
	notes: "Review the plan",
};
async function events() {
	return listCalendarEvents(
		owner,
		instant("2020-01-01T00:00:00Z"),
		instant("2040-01-01T00:00:00Z"),
	);
}
test("calendar events retain the source contract, stay private and survive backup/restore", async () => {
	const saved = await createCalendarEvent(
		owner,
		input({
			repeat: "monthly",
			repeatAnchorDay: 7,
			attendees: ["guest@example.net"],
		}),
		"UTC",
	);
	expect(saved.event).toMatchObject({
		title: "Planning",
		repeat: "monthly",
		repeatAnchorDay: 7,
		attendees: '["guest@example.net"]',
	});
	expect(saved.jobs).toEqual([]);
	expect(
		await listCalendarEvents(
			stranger,
			instant("2020-01-01T00:00:00Z"),
			instant("2040-01-01T00:00:00Z"),
		),
	).toEqual([]);
	await expect(
		updateCalendarEvent(stranger, saved.event.id, input(), "UTC"),
	).rejects.toMatchObject({ status: 404 });
	await expect(
		deleteCalendarEvent(stranger, saved.event.id),
	).rejects.toMatchObject({ status: 404 });
	const bookingEvent = await saveBookingEvent(owner, booking());
	await ensureBookingUsername(owner);
	const file = join(state.directory, "calendar-backup.json");
	await writeBackup(state.path, file);
	state.db.exec("DELETE FROM calendar_events");
	restoreBackup(state.db, await Bun.file(file).json());
	expect((await events())[0]).toMatchObject({
		id: saved.event.id,
		repeat: "monthly",
	});
	expect(
		(await loadPublicBookingEvent(bookingEvent.slug, "owner")).event.id,
	).toBe(bookingEvent.id);
});
test("editing a future recurring occurrence splits the series and deleting future occurrences preserves history", async () => {
	const saved = await createCalendarEvent(
		owner,
		input({ repeat: "daily" }),
		"UTC",
	);
	const split = "2030-01-10T09:00:00Z";
	await updateCalendarEvent(
		owner,
		`${saved.event.id}@${Date.parse(split)}`,
		input({
			title: "New plan",
			repeat: "daily",
			startsAt: split,
			endsAt: "2030-01-10T10:00:00Z",
		}),
		"UTC",
	);
	const rows = await events();
	expect(rows).toHaveLength(2);
	expect(
		rows.find((row) => row.id === saved.event.id)?.repeatUntil?.toISOString(),
	).toBe(instant(split).toISOString());
	const next = rows.find((row) => row.id !== saved.event.id);
	if (!next) throw new Error("Missing new series");
	await deleteCalendarEvent(owner, next.id, instant("2030-01-12T09:00:00Z"));
	const expanded = expandCalendarEvents(
		(await events()).map((row) => ({
			...row,
			startsAt: row.startsAt.toISOString(),
			endsAt: row.endsAt.toISOString(),
			repeatUntil: row.repeatUntil?.toISOString() ?? null,
		})),
		instant("2030-01-07T00:00:00Z"),
		instant("2030-01-14T00:00:00Z"),
	);
	expect(expanded).toHaveLength(5);
	expect(expanded.filter((event) => event.title === "Planning")).toHaveLength(
		3,
	);
	expect(expanded.filter((event) => event.title === "New plan")).toHaveLength(
		2,
	);
});
test("moving one occurrence to the past creates a standalone event without losing concurrent exclusions", async () => {
	const saved = await createCalendarEvent(
			owner,
			input({ repeat: "weekly" }),
			"UTC",
		),
		occurrence = Date.parse("2030-01-14T09:00:00Z");
	const move = input({
		title: "Moved meeting",
		moveOccurrenceToPast: true,
		startsAt: "2020-01-07T09:00:00Z",
		endsAt: "2020-01-07T10:00:00Z",
	});
	const attempts = await Promise.allSettled([
		updateCalendarEvent(owner, `${saved.event.id}@${occurrence}`, move, "UTC"),
		updateCalendarEvent(owner, `${saved.event.id}@${occurrence}`, move, "UTC"),
	]);
	expect(
		attempts.filter((result) => result.status === "fulfilled"),
	).toHaveLength(1);
	const rows = await events();
	expect(rows).toHaveLength(2);
	expect(
		rows.find((row) => row.id === saved.event.id)?.excludedOccurrences,
	).toBe(JSON.stringify([occurrence]));
	expect(rows.find((row) => row.id !== saved.event.id)?.repeat).toBe("none");
});
test("invitation attachments and deliveries commit with the event and use the existing Cloudflare sender", async () => {
	state.db.exec(
		"INSERT INTO mailrun_installation(id,account_id,zone_id,hostname,worker_name,public_origin,api_token,relay_secret,relay_version,phase,updated_at) VALUES ('primary','account','zone','example.com','relay','https://mail.example.com','token','secret','v1','ready',1)",
	);
	const saved = await createCalendarEvent(
		owner,
		input({
			mailboxId: "mailbox",
			from: "hello@example.com",
			attendees: ["maya@example.net", "lee@example.net"],
			description: "A calendar invitation",
		}),
		"UTC",
	);
	expect(saved.jobs).toHaveLength(2);
	const file = state.db
		.query<{ r2_key: string }, []>(
			"SELECT r2_key FROM message_attachments LIMIT 1",
		)
		.get();
	if (!file) throw new Error("Missing invitation file");
	const raw = await new LocalStorage().file(file.r2_key).text();
	expect(raw).toContain("BEGIN:VCALENDAR");
	expect(raw).toContain(`UID:${saved.event.id}@mailflare`);
	const payloads: unknown[] = [];
	expect(
		await deliverInvitations(saved.jobs, async (_url, init) => {
			payloads.push(JSON.parse(String(init?.body)));
			return Response.json({
				success: true,
				result: { message_id: crypto.randomUUID() + "@example.com" },
			});
		}),
	).toEqual([]);
	expect(payloads).toHaveLength(2);
	expect(payloads[0]).toMatchObject({
		subject: "Invitation: Planning",
		attachments: [
			{ filename: "invite.ics", type: "text/calendar; charset=utf-8" },
		],
	});
	expect(
		state.db
			.query("SELECT count(*) AS total FROM outbound_jobs WHERE status='sent'")
			.get(),
	).toEqual({ total: 2 });
});
test("calendar API keys enforce scope, disabled accounts and mailbox-limited invitation permissions", async () => {
	const value = "ep_calendar-fixture-key",
		keyHash = await bcrypt.hash(value, 4);
	state.db
		.query(
			"INSERT INTO api_keys (id,user_id,name,key_hash,prefix,scopes,created_at,mailbox_scope_enabled) VALUES (?,?,?,?,?,?,?,?)",
		)
		.run(
			"key",
			"owner",
			"Calendar",
			keyHash,
			value.slice(0, 12),
			'["calendar:read"]',
			1,
			1,
		);
	const key = await authenticateApiKey(
		new Request("https://mail.example/api/calendar/events", {
			headers: { Authorization: "Basic " + btoa("ignored:" + value) },
		}),
	);
	if (!key) throw new Error("Key was not authenticated");
	const create = new Request("https://mail.example/api/calendar/events", {
		method: "POST",
		body: JSON.stringify({
			title: "No access",
			startsAt: "2030-01-07T09:00:00Z",
			endsAt: "2030-01-07T10:00:00Z",
		}),
	});
	await expect(calendarApi(create, owner, key)).rejects.toMatchObject({
		status: 403,
	});
	const writer = { ...key, scopes: ["calendar:write"] };
	await expect(
		createCalendarEvent(
			owner,
			input({ mailboxId: "mailbox", attendees: ["guest@example.net"] }),
			"UTC",
			writer,
		),
	).rejects.toMatchObject({ status: 403 });
	expect(await events()).toHaveLength(0);
	const limited = {
		...writer,
		scopes: ["calendar:write", "send"],
		mailboxIds: [],
	};
	await expect(
		createCalendarEvent(
			owner,
			input({ mailboxId: "mailbox", attendees: ["guest@example.net"] }),
			"UTC",
			limited,
		),
	).rejects.toMatchObject({ status: 403 });
	state.db.exec("UPDATE users SET disabled=1 WHERE id='owner'");
	expect(
		await authenticateApiKey(
			new Request("https://mail.example/api/calendar/events", {
				headers: { Authorization: "Bearer " + value },
			}),
		),
	).toBeNull();
});
test("booking usernames are stable and unique, and editing another user's booking is rejected", async () => {
	expect(await ensureBookingUsername(owner)).toBe("owner");
	expect(await ensureBookingUsername(owner)).toBe("owner");
	await expect(updateBookingUsername(stranger, "owner")).rejects.toMatchObject({
		status: 403,
	});
	await expect(updateBookingUsername(owner, "..")).rejects.toMatchObject({
		status: 400,
	});
	state.db.exec(
		"UPDATE users SET booking_username='taken' WHERE id='stranger'",
	);
	await expect(updateBookingUsername(owner, "taken")).rejects.toMatchObject({
		status: 409,
	});
	expect(await updateBookingUsername(owner, "Owner.Meeting")).toBe(
		"owner.meeting",
	);
	const saved = await saveBookingEvent(owner, booking());
	await expect(
		saveBookingEvent(stranger, booking({ hostIds: ["stranger"] }), saved.id),
	).rejects.toMatchObject({ status: 404 });
	expect((await listBookingEvents(owner)).events).toHaveLength(1);
	await expect(saveBookingEvent(owner, booking())).rejects.toMatchObject({
		status: 409,
	});
});
test("booking availability uses every host and reservations atomically reject competing guests", async () => {
	enableTeamSharing(state.db);
	const saved = await saveBookingEvent(
			owner,
			booking({ hostIds: ["owner", "stranger"] }),
		),
		found = await loadPublicBookingEvent(saved.id, null);
	const now = instant("2030-01-06T00:00:00Z");
	const slots = await bookingSlots(found.event, now),
		slot = slots[0];
	if (!slot) throw new Error("No available slots");
	const attempts = await Promise.allSettled(
		Array.from({ length: 8 }, () =>
			reserveBooking(saved.id, slot.startsAt, guest, now),
		),
	);
	expect(
		attempts.filter((result) => result.status === "fulfilled"),
	).toHaveLength(1);
	expect(
		attempts.filter((result) => result.status === "rejected"),
	).toHaveLength(7);
	const booked = state.db
		.query<{ user_id: string; description: string; attendees: string }, []>(
			"SELECT user_id,description,attendees FROM calendar_events",
		)
		.all();
	expect(booked.map((row) => row.user_id).sort()).toEqual([
		"owner",
		"stranger",
	]);
	expect(booked[0]?.description).toBe(
		"Booked by A Guest (guest@example.net)\n\nReview the plan",
	);
	expect(booked[0]?.attendees).toBe(
		'["guest@example.net","colleague@example.net"]',
	);
	expect(
		(await bookingSlots(found.event, now)).some(
			(value) => value.startsAt === slot.startsAt,
		),
	).toBe(false);
});
test("recurring conflicts, exclusions and DST gaps use the original availability rules", async () => {
	const now = instant("2030-01-06T00:00:00Z"),
		saved = await saveBookingEvent(owner, booking()),
		found = await loadPublicBookingEvent(saved.id, null);
	const conflict = await createCalendarEvent(
		owner,
		input({
			repeat: "daily",
			startsAt: "2030-01-06T09:00:00Z",
			endsAt: "2030-01-06T10:00:00Z",
		}),
		"UTC",
	);
	expect(
		repeatsDuring(
			conflict.event,
			instant("2030-01-07T09:15:00Z"),
			instant("2030-01-07T09:45:00Z"),
		),
	).toBe(true);
	let slots = await bookingSlots(found.event, now);
	expect(
		slots.some((slot) => slot.startsAt === "2030-01-07T09:00:00.000Z"),
	).toBe(false);
	state.db
		.query("UPDATE calendar_events SET excluded_occurrences=? WHERE id=?")
		.run(
			JSON.stringify([Date.parse("2030-01-07T09:00:00Z")]),
			conflict.event.id,
		);
	slots = await bookingSlots(found.event, now);
	expect(
		slots.some((slot) => slot.startsAt === "2030-01-07T09:00:00.000Z"),
	).toBe(true);
	const dst = {
		...found.event,
		timeZone: "America/New_York",
		timeRanges: [{ startTime: "01:00", endTime: "04:00" }],
	};
	expect(slotFromLocalDate(dst, "2030-03-10", "02:30")).toBeNull();
	expect(
		slotFromLocalDate(dst, "2030-03-10", "03:00")?.startsAt.toISOString(),
	).toBe("2030-03-10T07:00:00.000Z");
});
test("public booking preserves both URL forms, validates guests, and hides disabled hosts", async () => {
	const saved = await saveBookingEvent(owner, booking());
	await ensureBookingUsername(owner);
	const byId = await publicBookingApi(
			new Request("https://mail.example/api/public/booking/" + saved.id),
		),
		bySlug = await publicBookingApi(
			new Request(
				"https://mail.example/api/public/booking/project-review?username=owner",
			),
		);
	expect(await byId?.json()).toEqual(await bySlug?.json());
	await expect(
		publicBookingApi(
			new Request("https://mail.example/api/public/booking/" + saved.id, {
				method: "POST",
				body: JSON.stringify({
					name: "Guest",
					email: "guest@example.net",
					startsAt: "2030-01-07T09:00:00Z",
					guestEmails: "invalid",
				}),
			}),
		),
	).rejects.toMatchObject({ status: 400 });
	state.db.exec("UPDATE users SET disabled=1 WHERE id='owner'");
	await expect(loadPublicBookingEvent(saved.id, null)).rejects.toMatchObject({
		status: 404,
	});
});
test("separate Bun processes cannot double-book a shared host through different booking links", async () => {
	const first = await saveBookingEvent(owner, booking()),
		second = await saveBookingEvent(owner, booking({ slug: "second-link" })),
		now = instant("2030-01-06T00:00:00Z");
	const found = await loadPublicBookingEvent(first.id, null),
		slot = (await bookingSlots(found.event, now))[0];
	if (!slot) throw new Error("No slot");
	const modulePath = new URL(
		"../src/server/calendar/booking.ts",
		import.meta.url,
	).href;
	const children = [first.id, second.id].map((eventId) =>
		Bun.spawn(
			[
				process.execPath,
				"-e",
				`import {reserveBooking} from ${JSON.stringify(modulePath)};try{await reserveBooking(${JSON.stringify(eventId)},${JSON.stringify(slot.startsAt)},${JSON.stringify(guest)},new Date(${JSON.stringify(now.toISOString())}));console.log(200);}catch(error){console.log(error instanceof Response?error.status:500);}`,
			],
			{
				env: { ...process.env, DATA_DIR: state.directory },
				stdout: "pipe",
				stderr: "pipe",
			},
		),
	);
	const results = await Promise.all(
		children.map(async (child) => ({
			exit: await child.exited,
			result: (await new Response(child.stdout).text()).trim(),
			error: await new Response(child.stderr).text(),
		})),
	);
	expect(results.map((result) => result.exit)).toEqual([0, 0]);
	expect(results.map((result) => result.result).sort()).toEqual(["200", "409"]);
	expect(
		state.db.query("SELECT count(*) AS total FROM calendar_events").get(),
	).toEqual({ total: 1 });
});

test("direct reservation checks match the public slot list across DST and booking-window boundaries", async () => {
	const saved = await saveBookingEvent(
		owner,
		booking({
			timeZone: "America/New_York",
			weekdays: [0, 1, 2, 3, 4, 5, 6],
			timeRanges: [{ startTime: "01:00", endTime: "04:00" }],
		}),
	);
	const { event } = await loadPublicBookingEvent(saved.id, null);
	for (const now of [
		instant("2030-03-09T00:00:00Z"),
		instant("2030-11-02T00:00:00Z"),
	]) {
		const slots = availableBookingSlots(event, [], 3, now);
		for (const slot of slots)
			expect(bookingSlotAtStart(event, [], slot.startsAt, 3, now)).toEqual(
				slot,
			);
		expect(
			bookingSlotAtStart(
				event,
				[],
				new Date(now.getTime() + 10 * 86400000).toISOString(),
				3,
				now,
			),
		).toBeNull();
		expect(
			bookingSlotAtStart(
				event,
				[],
				new Date(now.getTime() + 30 * 60000).toISOString(),
				3,
				now,
			),
		).toBeNull();
	}
	const now = instant("2030-03-09T00:00:00Z");
	expect(
		bookingSlotAtStart(event, [], "2030-03-10T07:30:00.001Z", 3, now),
	).toBeNull();
});
