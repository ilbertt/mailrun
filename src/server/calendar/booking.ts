import { withDatabase, id, seconds, type AppSQL } from "../db";
import type { User } from "../../shared/contracts";
import { z } from "zod";
import {
	parseBookingEventInput,
	parseBookingTimeRanges,
	parseBookingWeekdays,
	bookingUsernameFromEmail,
	normalizeBookingUsername,
} from "../../lib/booking/utils";
import { parseBookingHostIds } from "../../lib/booking/hosts";
import {
	availableBookingSlots,
	bookingSlotAtStart,
} from "../../lib/booking/availability";
import { calendarRecord } from "./contracts";
import type {
	BookingEventInput,
	BookingEventRecord,
} from "../../lib/booking/types";
import { licenseEntitlements } from "../licenses";
const storedBookingSchema = z.object({
	id: z.string(),
	user_id: z.string(),
	name: z.string(),
	slug: z.string(),
	description: z.string(),
	color: z.string(),
	host_ids: z.string(),
	duration_minutes: z.number(),
	location: z.string(),
	weekdays: z.string(),
	start_time: z.string(),
	end_time: z.string(),
	time_ranges: z.string(),
	time_zone: z.string(),
	enabled: z.number(),
	created_at: z.number(),
	updated_at: z.number(),
});
export function bookingRecord(value: unknown) {
	const row = storedBookingSchema.parse(value);
	return {
		id: row.id,
		userId: row.user_id,
		name: row.name,
		slug: row.slug,
		description: row.description,
		color: row.color,
		hostIds: row.host_ids,
		durationMinutes: row.duration_minutes,
		location: row.location,
		weekdays: row.weekdays,
		startTime: row.start_time,
		endTime: row.end_time,
		timeRanges: row.time_ranges,
		timeZone: row.time_zone,
		enabled: !!row.enabled,
		createdAt: new Date(row.created_at * 1000),
		updatedAt: new Date(row.updated_at * 1000),
	};
}
export function publicBookingRecord(value: unknown): BookingEventRecord {
	const row = bookingRecord(value);
	return {
		...row,
		hostIds: parseBookingHostIds(row.hostIds, row.userId),
		weekdays: parseBookingWeekdays(row.weekdays),
		timeRanges: parseBookingTimeRanges(row.timeRanges, {
			startTime: row.startTime,
			endTime: row.endTime,
		}),
	};
}
export async function ensureBookingUsername(user: User) {
	const [assigned] = await withDatabase(
		(sql) =>
			sql.NativeReadBookingUsername`SELECT booking_username FROM users WHERE id=${user.id} AND disabled=0`,
	);
	if (!assigned) throw new Response("User not found", { status: 404 });
	if (assigned.booking_username) return assigned.booking_username;
	return withDatabase((sql) =>
		sql.begin((tx) => assignBookingUsername(tx, user)),
	);
}
export async function assignBookingUsername(
	sql: AppSQL,
	user: Pick<User, "id" | "email">,
) {
	const [current] =
		await sql.NativeBookingUsername`UPDATE users SET booking_username=booking_username WHERE id=${user.id} AND disabled=0 RETURNING booking_username`;
	if (!current) throw new Response("User not found", { status: 404 });
	if (current.booking_username) return current.booking_username;
	const base = bookingUsernameFromEmail(user.email);
	for (let number = 1; number < 100000; number++) {
		const candidate = number === 1 ? base : base + number;
		const [updated] =
			await sql.NativeAssignBookingUsername`UPDATE users SET booking_username=${candidate} WHERE id=${user.id} AND booking_username IS NULL AND NOT EXISTS(SELECT 1 FROM users WHERE booking_username=${candidate}) RETURNING booking_username`;
		if (updated?.booking_username) return updated.booking_username;
	}
	throw new Error("Could not assign a booking username");
}

export async function updateBookingUsername(user: User, value: unknown) {
	if (user.role !== "admin")
		throw new Response("Only administrators can change booking usernames.", {
			status: 403,
		});
	const username = normalizeBookingUsername(value);
	if (!username)
		throw new Response(
			"Use up to 64 lowercase letters, numbers, dots, underscores, plus signs, or hyphens.",
			{ status: 400 },
		);
	const rows = await withDatabase(
		(sql) =>
			sql.NativeRenameBookingUsername`UPDATE users SET booking_username=${username} WHERE id=${user.id} AND NOT EXISTS(SELECT 1 FROM users WHERE booking_username=${username} AND id<>${user.id}) RETURNING id`,
	);
	if (!rows.length)
		throw new Response("This username is already taken.", { status: 409 });
	return username;
}
async function validHosts(
	sql: AppSQL,
	ownerId: string,
	requested: string[],
	canManageHosts: boolean,
) {
	const hosts = [ownerId, ...requested.filter((value) => value !== ownerId)];
	if (hosts.length > 20 || (!canManageHosts && hosts.length > 1)) return null;
	const active =
		await sql.NativeBookingHosts`SELECT id,name FROM users WHERE id IN(SELECT value FROM json_each(${JSON.stringify(hosts)})) AND disabled=0`;
	return active.length === hosts.length ? hosts : null;
}
export async function saveBookingEvent(
	user: User,
	value: unknown,
	eventId?: string,
) {
	const input = parseBookingEventInput(value);
	if (!input)
		throw new Response("Enter valid booking details and availability.", {
			status: 400,
		});
	const canManageHosts =
		user.role === "admin" && (await licenseEntitlements()).canShareMailboxes;
	return withDatabase((sql) =>
		sql.begin(async (tx) => {
			const [actor] =
				await tx.NativeBookingEditActor`UPDATE users SET booking_username=booking_username WHERE id=${user.id} AND disabled=0 RETURNING id`;
			if (!actor) throw new Response("Unauthorized", { status: 401 });
			const hosts = await validHosts(
				tx,
				user.id,
				input.hostIds,
				canManageHosts,
			);
			if (!hosts)
				throw new Response("Choose users from the host list.", { status: 400 });
			const [taken] =
				await tx.NativeBookingSlug`SELECT id FROM booking_events WHERE user_id=${user.id} AND slug=${input.slug}`;
			if (taken && taken.id !== eventId)
				throw new Response("This event link is already in use.", {
					status: 409,
				});
			const key = eventId ?? id("book");
			let rows;
			if (eventId) {
				rows =
					await tx.NativeUpdateBooking`UPDATE booking_events SET name=${input.name},slug=${input.slug},description=${input.description},color=${input.color},host_ids=${JSON.stringify(hosts)},duration_minutes=${input.durationMinutes},location=${input.location},weekdays=${JSON.stringify(input.weekdays)},start_time=${input.startTime},end_time=${input.endTime},time_ranges=${JSON.stringify(input.timeRanges)},time_zone=${input.timeZone},enabled=${input.enabled ? 1 : 0},updated_at=${seconds()} WHERE id=${key} AND user_id=${user.id} RETURNING *`;
			} else {
				rows =
					await tx.NativeCreateBooking`INSERT INTO booking_events (id,user_id,name,slug,description,color,host_ids,duration_minutes,location,weekdays,start_time,end_time,time_ranges,time_zone,enabled,created_at,updated_at) VALUES (${key},${user.id},${input.name},${input.slug},${input.description},${input.color},${JSON.stringify(hosts)},${input.durationMinutes},${input.location},${JSON.stringify(input.weekdays)},${input.startTime},${input.endTime},${JSON.stringify(input.timeRanges)},${input.timeZone},${input.enabled ? 1 : 0},${seconds()},${seconds()}) RETURNING *`;
			}
			if (!rows[0])
				throw new Response("Booking event not found", { status: 404 });
			return bookingRecord(rows[0]);
		}),
	);
}
export async function listBookingEvents(user: User) {
	const username = await ensureBookingUsername(user);
	const [events, [current]] = await withDatabase((sql) =>
		Promise.all([
			sql.NativeOwnedBookings`SELECT * FROM booking_events WHERE user_id=${user.id} ORDER BY created_at`,
			sql.NativeBookingProfile`SELECT avatar_key FROM users WHERE id=${user.id}`,
		]),
	);
	return {
		events: events.map(bookingRecord),
		username,
		currentUser: {
			id: user.id,
			name: user.name,
			email: user.email,
			hasAvatar: !!current?.avatar_key,
		},
		canManageHosts:
			user.role === "admin" && (await licenseEntitlements()).canShareMailboxes,
	};
}
export async function deleteBookingEvent(user: User, eventId: string) {
	const rows = await withDatabase(
		(sql) =>
			sql.NativeDeleteBooking`DELETE FROM booking_events WHERE id=${eventId} AND user_id=${user.id} RETURNING id`,
	);
	if (!rows.length)
		throw new Response("Booking event not found", { status: 404 });
}
export async function loadPublicBookingPage(
	username: string | null,
	userId: string | null,
) {
	username = username || null;
	if (!username && !userId)
		throw new Response("Missing booking page", { status: 400 });
	return withDatabase(async (sql) => {
		const [user] =
			await sql.NativePublicBookingUser`SELECT id,name,booking_username FROM users WHERE disabled=0 AND ((${username} IS NOT NULL AND booking_username=${username?.toLowerCase() ?? null}) OR (${username} IS NULL AND id=${userId})) LIMIT 1`;
		if (!user) throw new Response("Booking page not found", { status: 404 });
		const events =
			await sql.NativePublicBookings`SELECT id,slug,name,description,duration_minutes,location,weekdays,time_zone FROM booking_events WHERE user_id=${user.id} AND enabled=1 ORDER BY created_at`;
		return {
			name: user.name,
			username: user.booking_username,
			events: events.map((row) => ({
				id: row.id,
				slug: row.slug,
				name: row.name,
				description: row.description,
				durationMinutes: row.duration_minutes,
				location: row.location,
				weekdays: row.weekdays,
				timeZone: row.time_zone,
			})),
		};
	});
}
async function publicHosts(sql: AppSQL, event: BookingEventRecord) {
	const hosts =
		await sql.NativePublicBookingHosts`SELECT id,name FROM users WHERE id IN(SELECT value FROM json_each(${JSON.stringify(event.hostIds)})) AND disabled=0`;
	return hosts.length === event.hostIds.length ? hosts : null;
}
export async function loadPublicBookingEvent(
	eventId: string,
	username: string | null,
) {
	username = username || null;
	return withDatabase(async (sql) => {
		const [row] =
			await sql.NativePublicBookingEvent`SELECT b.* FROM booking_events b JOIN users u ON u.id=b.user_id WHERE b.enabled=1 AND u.disabled=0 AND ((${username} IS NOT NULL AND u.booking_username=${username?.toLowerCase() ?? null} AND b.slug=${eventId}) OR (${username} IS NULL AND b.id=${eventId})) LIMIT 1`;
		if (!row) throw new Response("Booking event not found", { status: 404 });
		const event = publicBookingRecord(row),
			hosts = await publicHosts(sql, event);
		if (!hosts) throw new Response("Booking event not found", { status: 404 });
		return {
			event,
			hostName: event.hostIds
				.map((id) => hosts.find((host) => host.id === id)?.name)
				.join(", "),
		};
	});
}
async function existingEvents(
	sql: AppSQL,
	event: BookingEventRecord,
	now: Date,
) {
	const rows =
		await sql.NativeBookingCalendarConflicts`SELECT * FROM calendar_events WHERE user_id IN(SELECT value FROM json_each(${JSON.stringify(event.hostIds)})) AND starts_at<${Math.floor(now.getTime() / 1000) + 62 * 86400} AND (ends_at>${Math.floor(now.getTime() / 1000)} OR repeat<>'none')`;
	return rows.map(calendarRecord);
}
export async function bookingSlots(
	event: BookingEventRecord,
	now = new Date(),
) {
	return withDatabase(async (sql) =>
		availableBookingSlots(
			event,
			await existingEvents(sql, event, now),
			60,
			now,
		),
	);
}
export async function reserveBooking(
	eventId: string,
	startsAt: string,
	guest: { name: string; email: string; guestEmails: string[]; notes: string },
	now = new Date(),
) {
	return withDatabase((sql) =>
		sql.begin(async (tx) => {
			// A write before reading availability serializes reservations across HTTP/cron processes.
			const [current] =
				await tx.NativeClaimPublicBooking`UPDATE booking_events SET updated_at=updated_at WHERE id=${eventId} AND enabled=1 RETURNING *`;
			if (!current)
				throw new Response("That time is no longer available.", {
					status: 409,
				});
			const event = publicBookingRecord(current);
			if (!(await publicHosts(tx, event)))
				throw new Response("That time is no longer available.", {
					status: 409,
				});
			const slot = bookingSlotAtStart(
				event,
				await existingEvents(tx, event, now),
				startsAt,
				60,
				now,
			);
			if (!slot)
				throw new Response("That time is no longer available.", {
					status: 409,
				});
			const requests = event.hostIds.map((userId) => ({
				userId,
				eventId: id("evt"),
			}));
			// All participating calendars are written in this transaction or none are.
			await tx.NativeReserveBooking`INSERT INTO calendar_events (id,user_id,mailbox_id,title,description,location,attendees,color,repeat,repeat_days,excluded_occurrences,time_zone,starts_at,ends_at,created_at,updated_at) SELECT json_extract(value,'$.eventId'),json_extract(value,'$.userId'),NULL,${event.name + " with " + guest.name},${[`Booked by ${guest.name} (${guest.email})`, guest.notes].filter(Boolean).join("\n\n")},${event.location},${JSON.stringify([guest.email, ...guest.guestEmails])},${event.color},'none','[]','[]',${event.timeZone},${Math.floor(Date.parse(slot.startsAt) / 1000)},${Math.floor(Date.parse(slot.endsAt) / 1000)},${seconds()},${seconds()} FROM json_each(${JSON.stringify(requests)})`;
			return { booked: true, startsAt: slot.startsAt, endsAt: slot.endsAt };
		}),
	);
}
