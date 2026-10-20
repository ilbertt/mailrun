import { getCookie, setCookie } from "@tanstack/react-start/server";
import { getUser, SESSION_COOKIE, SESSION_SECONDS } from "./service";
import { publicOrigin } from "../config";

export async function requireUser() {
	const user = await getUser(getCookie(SESSION_COOKIE));
	if (!user) throw new Response("Unauthorized", { status: 401 });
	return user;
}
export function sessionCookie(token: string) {
	setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: publicOrigin().startsWith("https:"), path: "/", maxAge: SESSION_SECONDS });
}
