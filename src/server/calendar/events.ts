import { withDatabase, id, seconds, type AppSQL } from "../db";
import type { User } from "../../shared/contracts";
import type { ApiKeyAuthorization } from "../auth/api-key";
import type { CalendarEventRecord } from "../../lib/calendar/types";
import { normalizeCalendarColor } from "../../lib/calendar/colors";
import {
	DEFAULT_REPEAT_DAYS,
	normalizeCalendarRepeatDays,
	parseCalendarRepeatDays,
	parseExcludedOccurrences,
	parseCalendarOccurrenceId,
} from "../../lib/calendar/recurrence";
import { calendarRecord, type CalendarInput } from "./contracts";
import { normalizeTimeZone } from "../../lib/time/utils";
import {
	prepareInvitations,
	queueInvitations,
	withInvitationFiles,
} from "./invitations";
export async function listCalendarEvents(user: User, start: Date, end: Date) {
	const rows = await withDatabase(
		(sql) =>
			sql.NativeCalendarEvents`SELECT * FROM calendar_events WHERE user_id=${user.id} AND starts_at<${Math.floor(end.getTime() / 1000)} AND (ends_at>=${Math.floor(start.getTime() / 1000)} OR repeat<>'none') ORDER BY starts_at`,
	);
	return rows.map(calendarRecord);
}
async function insertEvent(sql: AppSQL, event: CalendarEventRecord) {
	await sql.NativeInsertCalendarEvent`INSERT INTO calendar_events (id,user_id,mailbox_id,title,description,location,attendees,color,repeat,repeat_days,repeat_anchor_day,repeat_until,excluded_occurrences,time_zone,starts_at,ends_at,created_at,updated_at) VALUES (${event.id},${event.userId},${event.mailboxId},${event.title},${event.description},${event.location},${event.attendees},${event.color},${event.repeat},${event.repeatDays},${event.repeatAnchorDay},${event.repeatUntil ? Math.floor(event.repeatUntil.getTime() / 1000) : null},${event.excludedOccurrences},${event.timeZone},${Math.floor(event.startsAt.getTime() / 1000)},${Math.floor(event.endsAt.getTime() / 1000)},${Math.floor(event.createdAt.getTime() / 1000)},${Math.floor(event.updatedAt.getTime() / 1000)})`;
}
export async function createCalendarEvent(
	user: User,
	input: CalendarInput,
	timeZone: string,
	key: ApiKeyAuthorization | null = null,
) {
	const repeat = input.repeat ?? "none",
		repeatDays =
			repeat === "weekdays"
				? normalizeCalendarRepeatDays(input.repeatDays ?? DEFAULT_REPEAT_DAYS)
				: [];
	if (repeat === "weekdays" && !repeatDays.length)
		throw new Response("Choose at least one weekday", { status: 400 });
	const now = new Date();
	const event: CalendarEventRecord = {
		id: id("evt"),
		userId: user.id,
		mailboxId: input.mailboxId ?? null,
		title: input.title,
		description: input.description?.trim() ?? "",
		location: input.location?.trim() ?? "",
		attendees: JSON.stringify(input.attendees),
		color: normalizeCalendarColor(input.color),
		repeat,
		repeatDays: JSON.stringify(repeatDays),
		repeatAnchorDay:
			repeat === "monthly" ? (input.repeatAnchorDay ?? null) : null,
		repeatUntil: null,
		excludedOccurrences: "[]",
		timeZone: normalizeTimeZone(input.timeZone || timeZone),
		startsAt: input.startsAt,
		endsAt: input.endsAt,
		createdAt: now,
		updatedAt: now,
	};
	const plan = await prepareInvitations(user, key, event, input.from, false);
	const jobs = await withInvitationFiles(plan, () =>
		withDatabase((sql) =>
			sql.begin(async (tx) => {
				await insertEvent(tx, event);
				return queueInvitations(tx, user, plan);
			}),
		),
	);
	return { event, jobs };
}
export async function getCalendarEvent(user: User, eventId: string) {
	const occurrence = parseCalendarOccurrenceId(eventId),
		seriesId = occurrence?.seriesId ?? eventId;
	const [row] = await withDatabase(
		(sql) =>
			sql.NativeOwnedCalendarEvent`SELECT * FROM calendar_events WHERE id=${seriesId} AND user_id=${user.id}`,
	);
	if (!row) throw new Response("Event not found", { status: 404 });
	const event = calendarRecord(row);
	if (
		occurrence &&
		(event.repeat === "none" ||
			occurrence.startsAt < event.startsAt ||
			(event.repeatUntil && occurrence.startsAt >= event.repeatUntil))
	)
		throw new Response("Occurrence not found", { status: 404 });
	return { event, occurrence };
}
export async function updateCalendarEvent(
	user: User,
	eventId: string,
	input: CalendarInput,
	timeZone: string,
	key: ApiKeyAuthorization | null = null,
) {
	const { event: existing, occurrence } = await getCalendarEvent(user, eventId),
		effectiveFrom = input.effectiveFrom ?? occurrence?.startsAt;
	if (
		existing.repeat !== "none" &&
		effectiveFrom &&
		existing.repeatUntil &&
		effectiveFrom >= existing.repeatUntil
	)
		throw new Response("No future occurrences remain", { status: 404 });
	const repeat = input.repeat ?? existing.repeat,
		repeatDays =
			repeat === "weekdays"
				? normalizeCalendarRepeatDays(
						input.repeatDays ??
							(existing.repeat === "weekdays"
								? parseCalendarRepeatDays(existing.repeatDays)
								: DEFAULT_REPEAT_DAYS),
					)
				: [];
	if (repeat === "weekdays" && !repeatDays.length)
		throw new Response("Choose at least one weekday", { status: 400 });
	const now = new Date(),
		moving = !!input.moveOccurrenceToPast,
		splitAt = existing.repeat !== "none" ? effectiveFrom : null;
	let event: CalendarEventRecord = {
		...existing,
		title: input.title,
		description: input.description?.trim() ?? "",
		location: input.location?.trim() ?? "",
		attendees: JSON.stringify(input.attendees),
		color: normalizeCalendarColor(input.color ?? existing.color),
		repeat,
		repeatDays: JSON.stringify(repeatDays),
		repeatAnchorDay:
			repeat === "monthly"
				? (input.repeatAnchorDay ?? existing.repeatAnchorDay)
				: null,
		repeatUntil: repeat === "none" ? null : existing.repeatUntil,
		timeZone: normalizeTimeZone(
			input.timeZone || existing.timeZone || timeZone,
		),
		startsAt: input.startsAt,
		endsAt: input.endsAt,
		updatedAt: now,
	};
	if (moving) {
		if (!occurrence || existing.repeat === "none" || input.startsAt >= now)
			throw new Response("Choose a past time for this occurrence", {
				status: 400,
			});
		if (
			parseExcludedOccurrences(existing.excludedOccurrences).includes(
				occurrence.startsAt.getTime(),
			)
		)
			throw new Response("Occurrence already moved", { status: 409 });
		event = {
			...event,
			id: id("evt"),
			repeat: "none",
			repeatDays: "[]",
			repeatAnchorDay: null,
			repeatUntil: null,
			excludedOccurrences: "[]",
			timeZone: existing.timeZone,
			createdAt: now,
		};
	} else if (splitAt && splitAt > existing.startsAt)
		event = { ...event, id: id("evt"), createdAt: now };
	const plan = await prepareInvitations(
		user,
		key,
		{ ...event, id: moving ? event.id : existing.id },
		input.from,
		true,
	);
	const jobs = await withInvitationFiles(plan, () =>
		withDatabase((sql) =>
			sql.begin(async (tx) => {
				// Re-read while holding the write transaction so concurrent moves cannot lose exclusions.
				const [current] =
					await tx.NativeCalendarMutationGuard`UPDATE calendar_events SET updated_at=updated_at WHERE id=${existing.id} AND user_id=${user.id} RETURNING *`;
				if (!current) throw new Response("Event not found", { status: 404 });
				if (
					JSON.stringify(calendarRecord(current)) !== JSON.stringify(existing)
				)
					throw new Response("This event changed. Reload it before saving.", {
						status: 409,
					});
				if (moving && occurrence) {
					await insertEvent(tx, event);
					await tx.NativeExcludeCalendarOccurrence`UPDATE calendar_events SET excluded_occurrences=${JSON.stringify([...parseExcludedOccurrences(existing.excludedOccurrences), occurrence.startsAt.getTime()])},updated_at=${seconds()} WHERE id=${existing.id} AND user_id=${user.id}`;
				} else if (splitAt && splitAt > existing.startsAt) {
					await insertEvent(tx, event);
					await tx.NativeSplitCalendarSeries`UPDATE calendar_events SET repeat_until=${Math.floor(splitAt.getTime() / 1000)},updated_at=${seconds()} WHERE id=${existing.id} AND user_id=${user.id}`;
				} else {
					await tx.NativeUpdateCalendarEvent`UPDATE calendar_events SET title=${event.title},description=${event.description},location=${event.location},attendees=${event.attendees},color=${event.color},repeat=${event.repeat},repeat_days=${event.repeatDays},repeat_anchor_day=${event.repeatAnchorDay},repeat_until=${event.repeatUntil ? Math.floor(event.repeatUntil.getTime() / 1000) : null},time_zone=${event.timeZone},starts_at=${Math.floor(event.startsAt.getTime() / 1000)},ends_at=${Math.floor(event.endsAt.getTime() / 1000)},updated_at=${seconds()} WHERE id=${existing.id} AND user_id=${user.id}`;
				}
				return queueInvitations(tx, user, plan);
			}),
		),
	);
	return { event, jobs };
}
export async function deleteCalendarEvent(
	user: User,
	eventId: string,
	effectiveFrom?: Date,
) {
	const { event, occurrence } = await getCalendarEvent(user, eventId),
		cutoff = effectiveFrom ?? occurrence?.startsAt;
	if (event.repeat !== "none" && cutoff && cutoff > event.startsAt)
		await withDatabase(
			(sql) =>
				sql.NativeEndCalendarSeries`UPDATE calendar_events SET repeat_until=${Math.floor(cutoff.getTime() / 1000)},updated_at=${seconds()} WHERE id=${event.id} AND user_id=${user.id}`,
		);
	else
		await withDatabase(
			(sql) =>
				sql.NativeDeleteCalendarEvent`DELETE FROM calendar_events WHERE id=${event.id} AND user_id=${user.id}`,
		);
}
