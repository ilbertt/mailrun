import { dateFromZonedFields, zonedDateFields } from "@/lib/time/utils";
import {
	parseCalendarRepeatDays,
	parseExcludedOccurrences,
} from "@/lib/calendar/recurrence";
import { slotFromLocalDate, timeToMinutes } from "./utils";
import type { BookingEventRecord, ExistingCalendarEvent } from "./types";

export function repeatsDuring(
	event: ExistingCalendarEvent,
	start: Date,
	end: Date,
): boolean {
	const first = event.startsAt;
	const duration = event.endsAt.getTime() - first.getTime();
	if (event.repeat === "none") return first < end && event.endsAt > start;
	const zone = event.timeZone || "UTC";
	const firstWall = zonedDateFields(first, zone);
	const candidate = zonedDateFields(new Date(start.getTime() - duration), zone);
	const excluded = new Set(parseExcludedOccurrences(event.excludedOccurrences));
	for (
		let offset = 0;
		offset < Math.ceil(duration / 86_400_000) + 2;
		offset++
	) {
		const day = new Date(candidate);
		day.setUTCDate(day.getUTCDate() + offset);
		day.setUTCHours(
			firstWall.getUTCHours(),
			firstWall.getUTCMinutes(),
			firstWall.getUTCSeconds(),
			firstWall.getUTCMilliseconds(),
		);
		const days = Math.round(
			(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) -
				Date.UTC(
					firstWall.getUTCFullYear(),
					firstWall.getUTCMonth(),
					firstWall.getUTCDate(),
				)) /
				86_400_000,
		);
		if (days < 0) continue;
		const months =
			(day.getUTCFullYear() - firstWall.getUTCFullYear()) * 12 +
			day.getUTCMonth() -
			firstWall.getUTCMonth();
		const occurs =
			event.repeat === "daily" ||
			(event.repeat === "weekly" && days % 7 === 0) ||
			(event.repeat === "weekdays" &&
				parseCalendarRepeatDays(event.repeatDays).includes(day.getUTCDay())) ||
			(event.repeat === "monthly" &&
				months >= 0 &&
				day.getUTCDate() ===
					Math.min(
						event.repeatAnchorDay ?? firstWall.getUTCDate(),
						new Date(
							Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0),
						).getUTCDate(),
					));
		if (!occurs) continue;
		const occurrence = dateFromZonedFields(day, zone);
		if (
			occurrence < first ||
			(event.repeatUntil && occurrence >= event.repeatUntil) ||
			excluded.has(occurrence.getTime())
		)
			continue;
		if (occurrence < end && occurrence.getTime() + duration > start.getTime())
			return true;
	}
	return false;
}

export function availableBookingSlots(
	event: BookingEventRecord,
	existing: ExistingCalendarEvent[],
	days = 14,
	now = new Date(),
) {
	const today = zonedDateFields(now, event.timeZone);
	today.setUTCHours(0, 0, 0, 0);
	const slots: {
		startsAt: string;
		endsAt: string;
		localDate: string;
		time: string;
	}[] = [];
	for (let offset = 0; offset < days; offset++) {
		const day = new Date(today);
		day.setUTCDate(day.getUTCDate() + offset);
		if (!event.weekdays.includes(day.getUTCDay())) continue;
		const localDate = day.toISOString().slice(0, 10);
		for (const range of event.timeRanges)
			for (
				let minute = timeToMinutes(range.startTime);
				minute + event.durationMinutes <= timeToMinutes(range.endTime);
				minute += 15
			) {
				const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
				const slot = slotFromLocalDate(event, localDate, time);
				if (!slot || slot.startsAt.getTime() < now.getTime() + 60 * 60_000)
					continue;
				if (
					existing.some((calendarEvent) =>
						repeatsDuring(calendarEvent, slot.startsAt, slot.endsAt),
					)
				)
					continue;
				slots.push({
					startsAt: slot.startsAt.toISOString(),
					endsAt: slot.endsAt.toISOString(),
					localDate,
					time,
				});
			}
	}
	return slots;
}

/** Validate a submitted slot using the same rules as the public slot list. */
export function bookingSlotAtStart(
	event: BookingEventRecord,
	existing: ExistingCalendarEvent[],
	startsAt: string,
	days = 14,
	now = new Date(),
) {
	const selected = new Date(startsAt);
	if (
		!Number.isFinite(selected.getTime()) ||
		selected.getTime() < now.getTime() + 60 * 60_000
	)
		return null;
	const wall = zonedDateFields(selected, event.timeZone),
		today = zonedDateFields(now, event.timeZone);
	const dayIndex =
		(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate()) -
			Date.UTC(
				today.getUTCFullYear(),
				today.getUTCMonth(),
				today.getUTCDate(),
			)) /
		86400000;
	if (dayIndex < 0 || dayIndex >= days) return null;
	const localDate = wall.toISOString().slice(0, 10),
		time = `${String(wall.getUTCHours()).padStart(2, "0")}:${String(wall.getUTCMinutes()).padStart(2, "0")}`;
	const slot = slotFromLocalDate(event, localDate, time);
	if (!slot || slot.startsAt.toISOString() !== startsAt) return null;
	if (
		existing.some((calendarEvent) =>
			repeatsDuring(calendarEvent, slot.startsAt, slot.endsAt),
		)
	)
		return null;
	return {
		startsAt: slot.startsAt.toISOString(),
		endsAt: slot.endsAt.toISOString(),
		localDate,
		time,
	};
}
