import { z } from "zod";
import type { User } from "../../shared/contracts";
import {
	listBookingEvents,
	saveBookingEvent,
	deleteBookingEvent,
	updateBookingUsername,
	loadPublicBookingPage,
	loadPublicBookingEvent,
	bookingSlots,
	reserveBooking,
} from "../calendar/booking";
import { readLimitedBody } from "../mail/inbound";
import { parseBookingGuestEmails } from "../../lib/booking/guests";
const body = async (request: Request): Promise<unknown> =>
	JSON.parse(
		new TextDecoder().decode(await readLimitedBody(request, 32 * 1024)),
	);
export async function bookingApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	const path = new URL(request.url).pathname,
		method = request.method;
	if (path === "/api/booking/settings" && method === "PATCH") {
		const input = z
			.object({ username: z.unknown() })
			.parse(await body(request));
		return Response.json({
			username: await updateBookingUsername(user, input.username),
		});
	}
	if (path === "/api/booking") {
		if (method === "GET") return Response.json(await listBookingEvents(user));
		if (method === "POST")
			return Response.json({
				event: await saveBookingEvent(user, await body(request)),
			});
	}
	const match = /^\/api\/booking\/([^/]+)$/.exec(path);
	if (match) {
		const eventId = decodeURIComponent(match[1] ?? "");
		if (method === "PATCH")
			return Response.json({
				event: await saveBookingEvent(user, await body(request), eventId),
			});
		if (method === "DELETE") {
			await deleteBookingEvent(user, eventId);
			return Response.json({ ok: true });
		}
	}
	return null;
}
export async function publicBookingApi(
	request: Request,
): Promise<Response | null> {
	const url = new URL(request.url),
		path = url.pathname,
		method = request.method;
	if (path === "/api/public/booking") {
		if (method !== "GET")
			return new Response("Method not allowed", { status: 405 });
		return Response.json(
			await loadPublicBookingPage(
				url.searchParams.get("username"),
				url.searchParams.get("userId"),
			),
		);
	}
	const match = /^\/api\/public\/booking\/([^/]+)$/.exec(path);
	if (!match) return null;
	if (!["GET", "POST"].includes(method))
		return new Response("Method not allowed", { status: 405 });
	const found = await loadPublicBookingEvent(
		decodeURIComponent(match[1] ?? ""),
		url.searchParams.get("username"),
	);
	if (method === "GET")
		return Response.json({ ...found, slots: await bookingSlots(found.event) });
	const input = z
		.object({
			name: z.string().trim().min(1).max(120),
			email: z
				.string()
				.trim()
				.toLowerCase()
				.max(254)
				.regex(/^\S+@\S+\.\S+$/),
			startsAt: z.iso.datetime({ offset: true }),
			guestEmails: z.unknown().optional(),
			notes: z.string().trim().max(2000).default(""),
		})
		.parse(await body(request));
	const guestEmails = parseBookingGuestEmails(input.guestEmails, input.email);
	if (!guestEmails)
		throw new Response("Check the guest emails and meeting notes.", {
			status: 400,
		});
	return Response.json(
		await reserveBooking(found.event.id, input.startsAt, {
			...input,
			guestEmails,
		}),
	);
}
