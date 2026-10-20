import { createServerFn } from "@tanstack/react-start";
import { getCookie, deleteCookie } from "@tanstack/react-start/server";
import { z } from "zod";
import * as auth from "./server/auth/service";
import { requireUser, sessionCookie } from "./server/auth/request";
import { listMessages, listMailboxes, getThread, changeMessage } from "./server/mail/repository";
import { provisionEmail } from "./server/cloudflare/setup";
import { installationStatus } from "./server/cloudflare/installation";
import { sendMessage } from "./server/mail/send";
import { loginSchema, registerSchema, listInputSchema, messageActionSchema, setupCloudflareSchema, sendSchema } from "./shared/contracts";

export const sessionFn = createServerFn({ method: "GET" }).handler(async () => {
	const user = await auth.getUser(getCookie(auth.SESSION_COOKIE));
	return { user, needsSetup: !await auth.hasUsers() };
});
export const loginFn = createServerFn({ method: "POST" }).validator(loginSchema).handler(async ({ data }) => {
	const result = await auth.login(data);
	if (result.mfaRequired) return { mfaRequired: true as const };
	sessionCookie(result.token);
	return { mfaRequired: false as const, user: result.user };
});
export const registerFn = createServerFn({ method: "POST" }).validator(registerSchema).handler(async ({ data }) => {
	const result = await auth.register(data);
	sessionCookie(result.token);
	return { user: result.user };
});
export const logoutFn = createServerFn({ method: "POST" }).handler(async () => {
	await auth.logout(getCookie(auth.SESSION_COOKIE));
	deleteCookie(auth.SESSION_COOKIE, { path: "/" });
	return { ok: true };
});
export const mailboxesFn = createServerFn({ method: "GET" }).handler(async () => listMailboxes(await requireUser()));
export const messagesFn = createServerFn({ method: "GET" }).validator(listInputSchema).handler(async ({ data }) => listMessages(await requireUser(), data));
export const threadFn = createServerFn({ method: "GET" }).validator(z.object({ id: z.string().min(1) })).handler(async ({ data }) => getThread(await requireUser(), data.id));
export const messageActionFn = createServerFn({ method: "POST" }).validator(messageActionSchema).handler(async ({ data }) => changeMessage(await requireUser(), data));
export const setupStatusFn = createServerFn({ method: "GET" }).handler(async () => {
	const user = await requireUser();
	if (!user.isPrimaryAdmin) throw new Error("Forbidden");
	return installationStatus();
});
export const setupCloudflareFn = createServerFn({ method: "POST" }).validator(setupCloudflareSchema).handler(async ({ data }) => provisionEmail(await requireUser(), data));
export const sendFn = createServerFn({ method: "POST" }).validator(sendSchema).handler(async ({ data }) => sendMessage(await requireUser(), data));
