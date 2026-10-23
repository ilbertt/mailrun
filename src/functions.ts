import { getRequestLocale, loadServerMessages } from "./lib/i18n/server";
import {
	navigationCounts,
	moveMessages,
	shortcutSettings,
} from "./server/mail/navigation";
import { createServerFn } from "@tanstack/react-start";
import { getCookie, deleteCookie } from "@tanstack/react-start/server";
import { z } from "zod";
import * as auth from "./server/auth/service";
import { requireUser, sessionCookie } from "./server/auth/request";
import {
	listMessages,
	listMailboxes,
	getThread,
	changeMessage,
	mailCounts,
} from "./server/mail/repository";
import { provisionEmail, refreshRelay } from "./server/cloudflare/setup";
import { installationStatus } from "./server/cloudflare/installation";
import { sendMessage, sendDraft } from "./server/mail/send";
import {
	saveDraft,
	getDraft,
	deleteDraft,
	uploadAttachments,
	removeAttachment,
} from "./server/mail/drafts";
import {
	mailSettings,
	addAlias,
	removeAlias,
	saveRule,
	removeRule,
	setForwarding,
	setDomainAliases,
	createFolder,
} from "./server/mail/management";
import {
	draftSchema,
	sendDraftSchema,
	aliasSchema,
	ruleSchema,
} from "./shared/mail-contracts";
import {
	loginSchema,
	registerSchema,
	listInputSchema,
	messageActionSchema,
	setupCloudflareSchema,
	sendSchema,
} from "./shared/contracts";

export const sessionFn = createServerFn({ method: "GET" }).handler(async () => {
	const user = await auth.getUser(getCookie(auth.SESSION_COOKIE));
	return { user, needsSetup: !(await auth.hasUsers()) };
});
export const loginFn = createServerFn({ method: "POST" })
	.validator(loginSchema)
	.handler(async ({ data }) => {
		const result = await auth.login(data);
		if (result.mfaRequired) return { mfaRequired: true as const };
		sessionCookie(result.token);
		return { mfaRequired: false as const, user: result.user };
	});
export const registerFn = createServerFn({ method: "POST" })
	.validator(registerSchema)
	.handler(async ({ data }) => {
		const result = await auth.register(data);
		sessionCookie(result.token);
		return { user: result.user };
	});
export const logoutFn = createServerFn({ method: "POST" }).handler(async () => {
	await auth.logout(getCookie(auth.SESSION_COOKIE));
	deleteCookie(auth.SESSION_COOKIE, { path: "/" });
	return { ok: true };
});
export const mailboxesFn = createServerFn({ method: "GET" }).handler(async () =>
	listMailboxes(await requireUser()),
);
export const mailCountsFn = createServerFn({ method: "GET" })
	.validator(z.object({ mailboxId: z.string() }))
	.handler(async ({ data }) => mailCounts(await requireUser(), data.mailboxId));
export const messagesFn = createServerFn({ method: "GET" })
	.validator(listInputSchema)
	.handler(async ({ data }) => listMessages(await requireUser(), data));
export const threadFn = createServerFn({ method: "GET" })
	.validator(z.object({ id: z.string().min(1) }))
	.handler(async ({ data }) => getThread(await requireUser(), data.id));
export const messageActionFn = createServerFn({ method: "POST" })
	.validator(messageActionSchema)
	.handler(async ({ data }) => changeMessage(await requireUser(), data));
export const setupStatusFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const user = await requireUser();
		if (!user.isPrimaryAdmin) throw new Error("Forbidden");
		return installationStatus();
	},
);
export const setupCloudflareFn = createServerFn({ method: "POST" })
	.validator(setupCloudflareSchema)
	.handler(async ({ data }) => provisionEmail(await requireUser(), data));
export const refreshRelayFn = createServerFn({ method: "POST" }).handler(
	async () => refreshRelay(await requireUser()),
);
export const sendFn = createServerFn({ method: "POST" })
	.validator(sendSchema)
	.handler(async ({ data }) => sendMessage(await requireUser(), data));
export const saveDraftFn = createServerFn({ method: "POST" })
	.validator(draftSchema)
	.handler(async ({ data }) => saveDraft(await requireUser(), data));
export const draftFn = createServerFn({ method: "GET" })
	.validator(z.object({ id: z.string() }))
	.handler(async ({ data }) => getDraft(await requireUser(), data.id));
export const deleteDraftFn = createServerFn({ method: "POST" })
	.validator(z.object({ id: z.string() }))
	.handler(async ({ data }) => {
		await deleteDraft(await requireUser(), data.id);
		return { ok: true };
	});
export const sendDraftFn = createServerFn({ method: "POST" })
	.validator(sendDraftSchema)
	.handler(async ({ data }) =>
		sendDraft(await requireUser(), data.id, data.revision),
	);
export const uploadDraftFn = createServerFn({ method: "POST" })
	.validator((value: unknown) => {
		if (!(value instanceof FormData))
			throw new Error("Invalid attachment upload");
		return value;
	})
	.handler(async ({ data }) => {
		const draftId = z.string().min(1).parse(data.get("draftId"));
		const files = data
			.getAll("attachments")
			.filter((value): value is File => value instanceof File);
		return uploadAttachments(await requireUser(), draftId, files);
	});
export const removeDraftAttachmentFn = createServerFn({ method: "POST" })
	.validator(z.object({ id: z.string(), attachmentId: z.string() }))
	.handler(async ({ data }) =>
		removeAttachment(await requireUser(), data.id, data.attachmentId),
	);
export const mailSettingsFn = createServerFn({ method: "GET" }).handler(
	async () => mailSettings(await requireUser()),
);
export const addAliasFn = createServerFn({ method: "POST" })
	.validator(aliasSchema)
	.handler(async ({ data }) => addAlias(await requireUser(), data));
export const removeAliasFn = createServerFn({ method: "POST" })
	.validator(z.object({ id: z.string() }))
	.handler(async ({ data }) => {
		await removeAlias(await requireUser(), data.id);
		return { ok: true };
	});
export const saveRuleFn = createServerFn({ method: "POST" })
	.validator(ruleSchema)
	.handler(async ({ data }) => saveRule(await requireUser(), data));
export const removeRuleFn = createServerFn({ method: "POST" })
	.validator(z.object({ id: z.string() }))
	.handler(async ({ data }) => {
		await removeRule(await requireUser(), data.id);
		return { ok: true };
	});
export const forwardingFn = createServerFn({ method: "POST" })
	.validator(z.object({ email: z.email().or(z.literal("")) }))
	.handler(async ({ data }) => {
		await setForwarding(await requireUser(), data.email);
		return { ok: true };
	});
export const domainAliasesFn = createServerFn({ method: "POST" })
	.validator(z.object({ mailboxId: z.string(), enabled: z.boolean() }))
	.handler(async ({ data }) => {
		await setDomainAliases(await requireUser(), data.mailboxId, data.enabled);
		return { ok: true };
	});
export const createFolderFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			mailboxId: z.string(),
			name: z.string().trim().min(1).max(100),
			color: z.string().optional(),
		}),
	)
	.handler(async ({ data }) => createFolder(await requireUser(), data));

export const navigationCountsFn = createServerFn({ method: "GET" })
	.validator(z.object({ mailboxId: z.string() }))
	.handler(async ({ data }) =>
		navigationCounts(await requireUser(), data.mailboxId),
	);
export const bulkMessageActionFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			messageIds: z.array(z.string().min(1)).min(1).max(1000),
			action: z.enum(["archive", "spam", "trash", "folder"]),
			folderId: z.string().optional(),
		}),
	)
	.handler(async ({ data }) => moveMessages(await requireUser(), data));
export const shortcutSettingsFn = createServerFn({ method: "GET" }).handler(
	async () => shortcutSettings(await requireUser()),
);
export const updateShortcutSettingsFn = createServerFn({ method: "POST" })
	.validator(z.object({ enabled: z.boolean() }))
	.handler(async ({ data }) =>
		shortcutSettings(await requireUser(), data.enabled),
	);

export const localeFn = createServerFn({ method: "GET" }).handler(async () => {
	const locale = await getRequestLocale();
	return { locale, messages: await loadServerMessages(locale) };
});
