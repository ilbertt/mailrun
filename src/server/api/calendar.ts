import { z } from "zod";
import type { User } from "../../shared/contracts";
import type { ApiKeyAuthorization } from "../auth/api-key";
import { hasScope } from "../auth/api-key";
import { calendarInputSchema } from "../calendar/contracts";
import {
	createCalendarEvent,
	deleteCalendarEvent,
	listCalendarEvents,
	updateCalendarEvent,
} from "../calendar/events";
import { deliverInvitations } from "../calendar/invitations";
import { readLimitedBody } from "../mail/inbound";
import { currentProfile } from "./settings";
import { getRequestTimeZone } from "../../lib/time/utils";
export function isCalendarPath(path: string) {
	return /^\/api\/calendar\/events(?:\/[^/]+)?$/.test(path);
}
export async function calendarApi(
	request: Request,
	user: User,
	key: ApiKeyAuthorization | null = null,
): Promise<Response | null> {
	const url = new URL(request.url),
		method = request.method;
	if (!isCalendarPath(url.pathname)) return null;
	if (!["GET", "POST", "PATCH", "DELETE"].includes(method))
		return new Response("Method not allowed", { status: 405 });
	if (
		key &&
		!hasScope(key, method === "GET" ? "calendar:read" : "calendar:write")
	)
		throw new Response("Permission denied", { status: 403 });
	const suffix = url.pathname.slice("/api/calendar/events".length),
		eventId = suffix ? decodeURIComponent(suffix.slice(1)) : null;
	if (
		(eventId && !["PATCH", "DELETE"].includes(method)) ||
		(!eventId && !["GET", "POST"].includes(method))
	)
		return new Response("Method not allowed", { status: 405 });
	const json = (value: unknown, status = 200) =>
		Response.json(value, { status });
	if (method === "GET" && !eventId) {
		const now = new Date(),
			start = z.coerce.date().parse(url.searchParams.get("start") ?? now),
			end = z.coerce
				.date()
				.parse(
					url.searchParams.get("end") ??
						new Date(start.getTime() + 31 * 86400000),
				);
		if (end <= start)
			throw new Response("Choose a valid calendar range", { status: 400 });
		return json({ events: await listCalendarEvents(user, start, end) });
	}
	const bytes = await readLimitedBody(request, 64 * 1024),
		body: unknown = bytes.length
			? JSON.parse(new TextDecoder().decode(bytes))
			: {};
	if (method === "DELETE" && eventId) {
		const { effectiveFrom } = z
			.object({
				effectiveFrom: z.iso
					.datetime({ offset: true })
					.transform((value) => new Date(value))
					.optional(),
			})
			.parse(body);
		await deleteCalendarEvent(user, eventId, effectiveFrom);
		return json({ ok: true });
	}
	if ((method === "POST" && !eventId) || (method === "PATCH" && eventId)) {
		const input = calendarInputSchema.parse(body),
			profile = await currentProfile(user),
			zone = getRequestTimeZone(request, profile.time_zone);
		const result = eventId
			? await updateCalendarEvent(user, eventId, input, zone, key)
			: await createCalendarEvent(user, input, zone, key);
		const errors = await deliverInvitations(result.jobs);
		if (errors.length)
			return json(
				{
					eventSaved: true,
					event: result.event,
					error:
						"Event saved, but an invitation could not be delivered. Check the failed message before retrying.",
				},
				502,
			);
		return json(eventId ? { ok: true } : { event: result.event });
	}
	return null;
}
