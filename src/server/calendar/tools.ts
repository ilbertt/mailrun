import { withDatabase, id, seconds } from "../db";
import { assertApiPrincipal } from "../auth/key-principal";
import { withToolUserMutation } from "../agent/access";
import { listCalendarEvents } from "./events";
import { calendarRecord } from "./contracts";
import { calendarToolSchemas } from "./tool-contracts";
import { normalizeTimeZone, zonedDateFields } from "../../lib/time/utils";
import {
	DEFAULT_REPEAT_DAYS,
	normalizeCalendarRepeatDays,
	parseCalendarOccurrenceId,
} from "../../lib/calendar/recurrence";
import { normalizeCalendarColor } from "../../lib/calendar/colors";
import { expandToolEvents } from "../../lib/calendar/tool-occurrences";
import type {
	CalendarToolContext,
	CalendarToolName,
} from "../../lib/calendar/tool-types";
export {
	CALENDAR_TOOL_NAMES,
	calendarToolDescriptions,
	calendarToolSchemas,
	calendarToolScope,
} from "./tool-contracts";
export async function runCalendarTool(
	ctx: CalendarToolContext,
	name: CalendarToolName,
	rawInput: unknown,
): Promise<unknown> {
	const input = calendarToolSchemas[name].parse(rawInput) as Record<
		string,
		unknown
	>;
	await withDatabase(async (sql) => {
		await assertApiPrincipal(sql, ctx.actor ?? ctx.user);
		const [user] =
			await sql.NativeCalendarToolUser`SELECT id FROM users WHERE id=${ctx.user.id} AND disabled=0`;
		if (!user) throw new Error("Unauthorized");
	});
	if (name === "get_calendars")
		return {
			calendars: [
				{
					id: "personal",
					name: "Personal calendar",
					timeZone: normalizeTimeZone(ctx.timeZone),
					writable: true,
				},
			],
		};
	if (
		name === "get_schedule" ||
		name === "search_events" ||
		name === "find_free_time"
	) {
		const from = new Date(input.start as string),
			to = new Date(input.end as string);
		if (to <= from || to.getTime() - from.getTime() > 90 * 86400000)
			throw new Error("Choose a positive range of at most 90 days");
		const events = expandToolEvents(
			await listCalendarEvents(ctx.user, from, to),
			from,
			to,
		);
		if (name === "get_schedule")
			return { events, truncated: events.length >= 500 };
		if (name === "search_events") {
			const query = (input.query as string).toLocaleLowerCase(),
				matches = events.filter((event) =>
					[event.title, event.description, event.location].some((value) =>
						value.toLocaleLowerCase().includes(query),
					),
				);
			return {
				events: matches.slice(0, input.limit as number),
				truncated:
					events.length >= 500 || matches.length > (input.limit as number),
			};
		}
		const duration = (input.durationMinutes as number) * 60000,
			busy = events
				.map((event) => ({
					start: Math.max(from.getTime(), Date.parse(event.startsAt)),
					end: Math.min(to.getTime(), Date.parse(event.endsAt)),
				}))
				.sort((a, b) => a.start - b.start),
			slots: { startsAt: string; endsAt: string }[] = [];
		let cursor = from.getTime();
		for (const block of [...busy, { start: to.getTime(), end: to.getTime() }]) {
			if (block.start - cursor >= duration)
				slots.push({
					startsAt: new Date(cursor).toISOString(),
					endsAt: new Date(block.start).toISOString(),
				});
			cursor = Math.max(cursor, block.end);
			if (slots.length >= (input.limit as number)) break;
		}
		return { slots, truncated: events.length >= 500 };
	}
	if (name === "get_event") {
		const occurrence = parseCalendarOccurrenceId(input.eventId as string),
			[row] = await withDatabase(
				(sql) =>
					sql.NativeCalendarToolGet`SELECT * FROM calendar_events WHERE user_id=${ctx.user.id} AND id=${occurrence?.seriesId ?? (input.eventId as string)}`,
			);
		if (!row) throw new Error("Event not found");
		const event = calendarRecord(row);
		if (!occurrence) return { event };
		const found = expandToolEvents(
			[event],
			occurrence.startsAt,
			new Date(occurrence.startsAt.getTime() + 1),
		).find((item) => item.id === input.eventId);
		if (!found) throw new Error("Occurrence not found");
		return { event: found };
	}
	if (name === "create_event") {
		const start = new Date(input.startsAt as string),
			end = new Date(input.endsAt as string),
			zone = normalizeTimeZone((input.timeZone as string) ?? ctx.timeZone),
			repeatDays = normalizeCalendarRepeatDays(
				input.repeatDays ?? DEFAULT_REPEAT_DAYS,
			),
			eventId = id("evt");
		if (end <= start) throw new Error("Event end must be after its start");
		if (input.repeat === "weekdays" && !repeatDays.length)
			throw new Error("Choose at least one weekday");
		await withToolUserMutation(ctx, async (sql) => {
			await sql.NativeCalendarToolCreate`INSERT INTO calendar_events(id,user_id,title,description,location,starts_at,ends_at,time_zone,color,repeat,repeat_days,repeat_anchor_day,attendees,created_at,updated_at) VALUES(${eventId},${ctx.user.id},${input.title as string},${(input.description as string) ?? ""},${(input.location as string) ?? ""},${Math.floor(start.getTime() / 1000)},${Math.floor(end.getTime() / 1000)},${zone},${normalizeCalendarColor(input.color as string | undefined)},${input.repeat as string},${JSON.stringify(repeatDays)},${input.repeat === "monthly" ? zonedDateFields(start, zone).getUTCDate() : null},${JSON.stringify(input.attendees ?? [])},${seconds()},${seconds()})`;
		});
		return { eventId, status: "created" };
	}
	if (name === "update_events") {
		const updates = calendarToolSchemas.update_events.parse(rawInput).updates,
			ids = updates.map((item) => item.eventId);
		if (
			new Set(ids).size !== ids.length ||
			ids.some((value) => parseCalendarOccurrenceId(value))
		)
			throw new Error("Use unique series IDs for updates");
		await withToolUserMutation(ctx, async (sql) => {
			for (const item of updates) {
				const [raw] =
					await sql.NativeCalendarToolUpdateGuard`SELECT * FROM calendar_events WHERE id=${item.eventId} AND user_id=${ctx.user.id}`;
				if (!raw) throw new Error("Event not found");
				const row = calendarRecord(raw),
					start = item.startsAt ? new Date(item.startsAt) : row.startsAt,
					end = item.endsAt ? new Date(item.endsAt) : row.endsAt,
					zone = normalizeTimeZone(item.timeZone || row.timeZone),
					repeat = item.repeat ?? row.repeat,
					days = item.repeatDays
						? JSON.stringify(normalizeCalendarRepeatDays(item.repeatDays))
						: row.repeatDays;
				if (end <= start) throw new Error("Event end must be after its start");
				if (
					repeat === "weekdays" &&
					!normalizeCalendarRepeatDays(JSON.parse(days)).length
				)
					throw new Error("Choose at least one weekday");
				await sql.NativeCalendarToolUpdate`UPDATE calendar_events SET title=${item.title ?? row.title},description=${item.description ?? row.description},location=${item.location ?? row.location},starts_at=${Math.floor(start.getTime() / 1000)},ends_at=${Math.floor(end.getTime() / 1000)},time_zone=${zone},color=${item.color ? normalizeCalendarColor(item.color) : row.color},repeat=${repeat},repeat_days=${days},repeat_anchor_day=${repeat === "monthly" ? zonedDateFields(start, zone).getUTCDate() : null},attendees=${item.attendees ? JSON.stringify(item.attendees) : row.attendees},updated_at=${seconds()} WHERE id=${row.id} AND user_id=${ctx.user.id}`;
			}
		});
		return { eventIds: ids, status: "updated" };
	}
	const ids = input.eventIds as string[];
	if (
		new Set(ids).size !== ids.length ||
		ids.some((value) => parseCalendarOccurrenceId(value))
	)
		throw new Error("Use unique series IDs for deletion");
	await withToolUserMutation(ctx, async (sql) => {
		const rows =
			await sql.NativeCalendarToolDeleteGuard`SELECT id FROM calendar_events WHERE user_id=${ctx.user.id} AND id IN(SELECT value FROM json_each(${JSON.stringify(ids)}))`;
		if (rows.length !== ids.length) throw new Error("Event not found");
		await sql.NativeCalendarToolDelete`DELETE FROM calendar_events WHERE user_id=${ctx.user.id} AND id IN(SELECT value FROM json_each(${JSON.stringify(ids)}))`;
	});
	return { eventIds: ids, status: "deleted" };
}
