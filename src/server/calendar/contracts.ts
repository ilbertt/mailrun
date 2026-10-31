import { z } from "zod";
import { normalizeCalendarRepeat } from "../../lib/calendar/recurrence";
import type { CalendarEventRecord } from "../../lib/calendar/types";
export const instant = z.iso
	.datetime({ offset: true })
	.transform((value) => new Date(value));
export const calendarInputSchema = z
	.object({
		title: z.string().trim().min(1).max(500),
		description: z.string().max(10_000).optional(),
		location: z.string().max(500).optional(),
		attendees: z
			.array(z.string().trim().max(254))
			.max(50)
			.default([])
			.transform((values) =>
				values.filter((value) => /^\S+@\S+\.\S+$/.test(value)),
			),
		color: z.string().max(30).optional(),
		repeat: z
			.string()
			.max(20)
			.optional()
			.transform((value) =>
				value === undefined ? undefined : normalizeCalendarRepeat(value),
			),
		repeatDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
		repeatAnchorDay: z.number().int().min(1).max(31).optional(),
		timeZone: z.string().max(80).optional(),
		effectiveFrom: instant.optional(),
		moveOccurrenceToPast: z.boolean().optional(),
		startsAt: instant,
		endsAt: instant,
		mailboxId: z.string().min(1).max(200).nullable().optional(),
		from: z.string().max(500).optional(),
	})
	.refine(
		(value) => value.endsAt > value.startsAt,
		"Enter a title and valid event times",
	);
export type CalendarInput = z.infer<typeof calendarInputSchema>;
const storedEvent = z.object({
	id: z.string(),
	user_id: z.string(),
	mailbox_id: z.string().nullable(),
	title: z.string(),
	description: z.string(),
	location: z.string(),
	attendees: z.string(),
	color: z.string(),
	repeat: z.string(),
	repeat_days: z.string(),
	repeat_anchor_day: z.number().nullable(),
	repeat_until: z.number().nullable(),
	excluded_occurrences: z.string(),
	time_zone: z.string().nullable(),
	starts_at: z.number(),
	ends_at: z.number(),
	created_at: z.number(),
	updated_at: z.number(),
});
export function calendarRecord(value: unknown): CalendarEventRecord {
	const row = storedEvent.parse(value),
		date = (value: number) => new Date(value * 1000);
	return {
		id: row.id,
		userId: row.user_id,
		mailboxId: row.mailbox_id,
		title: row.title,
		description: row.description,
		location: row.location,
		attendees: row.attendees,
		color: row.color,
		repeat: normalizeCalendarRepeat(row.repeat),
		repeatDays: row.repeat_days,
		repeatAnchorDay: row.repeat_anchor_day,
		repeatUntil: row.repeat_until === null ? null : date(row.repeat_until),
		excludedOccurrences: row.excluded_occurrences,
		timeZone: row.time_zone,
		startsAt: date(row.starts_at),
		endsAt: date(row.ends_at),
		createdAt: date(row.created_at),
		updatedAt: date(row.updated_at),
	};
}
