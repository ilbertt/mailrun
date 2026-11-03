import {
	getCookie,
	setCookie,
	getRequestHeader,
	setResponseHeader,
} from "@tanstack/react-start/server";
import { getUser, SESSION_COOKIE, SESSION_SECONDS } from "./service";
import { publicOrigin } from "../config";

export async function requireUser() {
	const cookieUser = await getUser(getCookie(SESSION_COOKIE));
	const user =
		cookieUser ??
		(await getUser(
			getRequestHeader("Authorization")?.match(/^Bearer (.+)$/)?.[1],
		));
	if (!user) throw new Response("Unauthorized", { status: 401 });
	setResponseHeader(
		"X-Mailflare-Session-Transport",
		cookieUser ? "cookie" : "bearer",
	);
	return user;
}
export function sessionCookie(token: string) {
	setCookie(SESSION_COOKIE, token, {
		httpOnly: true,
		sameSite: "lax",
		secure: publicOrigin().startsWith("https:"),
		path: "/",
		maxAge: SESSION_SECONDS,
	});
}
