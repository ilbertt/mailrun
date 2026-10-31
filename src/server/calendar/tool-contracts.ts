import { z } from "zod";
import { toolEmailSchema } from "../agent/schema-utils";
import type { CalendarToolName } from "../../lib/calendar/tool-types";
const id = z.string().min(1).max(160);
const instant = z.string().datetime({ offset: true });
const range = { start: instant, end: instant };
const repeat = z.enum(["none", "daily", "weekly", "monthly", "weekdays"]);
const fields = {
	title: z.string().trim().min(1).max(500),
	description: z.string().max(10_000),
	location: z.string().max(500),
	startsAt: instant,
	endsAt: instant,
	timeZone: z.string().max(80),
	color: z.string().max(30),
	repeat,
	repeatDays: z.array(z.number().int().min(0).max(6)).max(7),
	attendees: z.array(toolEmailSchema).max(50),
};
const update = z.object({
	eventId: id,
	title: fields.title.optional(),
	description: fields.description.optional(),
	location: fields.location.optional(),
	startsAt: instant.optional(),
	endsAt: instant.optional(),
	timeZone: fields.timeZone.optional(),
	color: fields.color.optional(),
	repeat: repeat.optional(),
	repeatDays: fields.repeatDays.optional(),
	attendees: fields.attendees.optional(),
});

export const calendarToolSchemas = {
	get_schedule: z.object({ ...range }),
	search_events: z.object({
		query: z.string().trim().min(1).max(300),
		...range,
		limit: z.number().int().min(1).max(100).default(50),
	}),
	get_event: z.object({ eventId: id }),
	create_event: z.object({
		title: fields.title,
		startsAt: instant,
		endsAt: instant,
		description: fields.description.optional(),
		location: fields.location.optional(),
		timeZone: fields.timeZone.optional(),
		color: fields.color.optional(),
		repeat: repeat.default("none"),
		repeatDays: fields.repeatDays.optional(),
		attendees: fields.attendees.optional(),
	}),
	update_events: z.object({ updates: z.array(update).min(1).max(20) }),
	delete_events: z.object({ eventIds: z.array(id).min(1).max(20) }),
	find_free_time: z.object({
		...range,
		durationMinutes: z.number().int().min(5).max(1_440),
		limit: z.number().int().min(1).max(30).default(10),
	}),
	get_calendars: z.object({}),
} as const;

export const calendarToolDescriptions: Record<CalendarToolName, string> = {
	get_schedule:
		"List the user's calendar events and recurring occurrences in an ISO 8601 time range, up to 90 days.",
	search_events:
		"Search event title, description, and location in an ISO 8601 time range, up to 90 days.",
	get_event:
		"Get an event or recurring occurrence by ID. Returns its series ID for edits.",
	create_event:
		"Create an event in the user's personal calendar. This saves immediately; attendees are recorded but invitations are not sent.",
	update_events:
		"Update up to 20 owned event series by series ID. Changes apply to the whole series and save immediately; invitations are not sent.",
	delete_events:
		"Delete up to 20 owned event series by series ID. This saves immediately and does not send cancellations.",
	find_free_time:
		"Find available slots using the user's events in an ISO 8601 time range, up to 90 days. Returns UTC instants.",
	get_calendars:
		"List the calendars available here. Mailflare currently has one personal calendar per user.",
};

export const CALENDAR_TOOL_NAMES = Object.keys(
	calendarToolSchemas,
) as CalendarToolName[];
export const calendarToolScope = (name: CalendarToolName) =>
	name === "create_event" ||
	name === "update_events" ||
	name === "delete_events"
		? "mcp:calendar-write"
		: "mcp:calendar-read";
