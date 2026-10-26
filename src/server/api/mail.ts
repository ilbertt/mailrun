import { driveApi } from "./drive";
import { publicDriveApi } from "../drive/sharing";
import { calendarApi, isCalendarPath } from "./calendar";
import { bookingApi, publicBookingApi } from "./booking";
import { authenticateApiKey } from "../auth/api-key";
import { getRequestTimeZone } from "../../lib/time/utils";
import { licensesApi } from "./licenses";
import { adminReadApi } from "./admin-read";
import { pushApi } from "./push";
import { templatesApi } from "./templates";
import { avatarsApi } from "./avatars";
import { contactsApi } from "./contacts";
import { messageContacts } from "../mail/contacts";
import { rulesApi } from "./rules";
import { mailboxesApi } from "./mailboxes";
import { settingsApi, currentProfile } from "./settings";
import { brandingApi } from "../branding";
import { licenseEntitlements } from "../licenses";
import { sourceCounts } from "../mail/counts";
import { LocalStorage } from "../storage";
import { extractUnsubscribeUrlFromRaw } from "../../lib/email/unsubscribe";
import { draftsApi } from "./drafts";
import { authApi } from "./auth";
import { getCookie } from "@tanstack/react-start/server";
import { getUser } from "../auth/service";
import { z } from "zod";
import { publicOrigin } from "../config";
import { requireUser } from "../auth/request";
import { withDatabase, seconds } from "../db";
import type { User, Folder } from "../../shared/contracts";
import { folderSchema } from "../../shared/contracts";
import {
	queryMessages,
	toMessage,
	iso,
	messageQuerySchema,
	type MessageQueryInput,
} from "../mail/message-query";
import {
	bulkAction,
	bulkActionSchema,
	emptyFolder,
	messageRecord,
	snooze,
	toggleStar,
} from "../mail/message-actions";
import { mailSettings, createFolder } from "../mail/management";
import { listMailboxes, getThread } from "../mail/repository";
import { navigationCounts } from "../mail/navigation";
import { mailboxAccess } from "../mail/access";

function folderInput(folder: Folder): MessageQueryInput {
	switch (folder) {
		case "inbox":
			return { direction: "inbound", status: "received" };
		case "sent":
			return { direction: "outbound", status: "sent" };
		case "scheduled":
			return { direction: "outbound", scheduled: "true" };
		case "drafts":
			return { direction: "outbound", status: "draft" };
		case "snoozed":
			return { snoozed: "true" };
		case "starred":
			return { starred: "true" };
		default:
			return { status: folder };
	}
}
export async function dispatchMailApi(
	request: Request,
	user: User,
): Promise<Response> {
	const url = new URL(request.url),
		path = url.pathname,
		method = request.method,
		params = url.searchParams;
	const drive = await driveApi(request, user);
	if (drive) return drive;
	const calendar = await calendarApi(request, user);
	if (calendar) return calendar;
	const booking = await bookingApi(request, user);
	if (booking) return booking;
	const brand = await brandingApi(
		request,
		user.role === "admin" && user.isPrimaryAdmin,
	);
	if (brand) return brand;
	const settings = await settingsApi(request, user);
	if (settings) return settings;
	const boxes = await mailboxesApi(request, user);
	if (boxes) return boxes;
	const rules = await rulesApi(request, user);
	if (rules) return rules;
	const contacts = await contactsApi(request, user);
	if (contacts) return contacts;
	const avatars = await avatarsApi(request, user);
	if (avatars) return avatars;
	const push = await pushApi(request, user);
	if (push) return push;
	const templates = await templatesApi(request, user);
	if (templates) return templates;
	const licenses = await licensesApi(request, user);
	if (licenses) return licenses;
	const adminRead = await adminReadApi(request, user);
	if (adminRead) return adminRead;
	const drafts = await draftsApi(request, user);
	if (drafts) return drafts;
	const json = (value: unknown, status = 200) =>
		Response.json(value, { status });
	if (method === "GET" && path === "/api/agent/availability") {
		const [row] = await withDatabase(
			(sql) =>
				sql.NativeAgentAvailability`SELECT agent_enabled FROM app_settings WHERE id='default'`,
		);
		return json({ enabled: row ? !!row.agent_enabled : true });
	}
	if (method === "GET" && path === "/api/auth/me") {
		const profile = await currentProfile(user);
		const [setup] = await withDatabase(
			(sql) => sql.NativeSetupMetadata`SELECT id FROM domains LIMIT 1`,
		);
		const boxes = await listMailboxes(user);
		return json({
			user: {
				id: profile.id,
				name: profile.name,
				email: profile.email,
				role: profile.role,
				timeZone: profile.time_zone,
				resetEmail: profile.reset_email,
				forwardingEmail: profile.forwarding_email,
				hasAvatar: !!profile.avatar_key,
				keyboardShortcutsEnabled: !!profile.keyboard_shortcuts_enabled,
				isPrimaryAdmin: !!profile.is_primary_admin,
				canManageMailboxes:
					!!profile.is_primary_admin || !!profile.can_manage_mailboxes,
				canManageDomains:
					!!profile.is_primary_admin || !!profile.can_manage_domains,
				canManageUsers:
					!!profile.is_primary_admin || !!profile.can_manage_users,
				spamProtectionEnabled: !!profile.spam_protection_enabled,
				showFullRecipientAddresses: !!profile.show_full_recipient_addresses,
				mfaEnabled: !!profile.totp_enabled,
				canForwardEmail: (await licenseEntitlements()).canForwardEmail,
			},
			runtime: "node",
			managesDns: !!process.env.CF_TOKEN,
			hasMailboxes: boxes.length > 0,
			isSetup: !!setup,
		});
	}
	if (path === "/api/folders") {
		if (method === "GET") {
			const mailboxId = params.get("mailboxId");
			if (!mailboxId) return json({ folders: [] });
			await mailboxAccess(user, mailboxId);
			const settings = await mailSettings(user);
			return json({
				folders: settings.folders
					.filter((folder) => folder.mailbox_id === mailboxId)
					.map((folder) => ({
						id: folder.id,
						name: folder.name,
						color: folder.color,
						mailboxId: folder.mailbox_id,
					})),
			});
		}
		if (method === "POST") {
			const input = z
				.object({
					mailboxId: z.string(),
					name: z.string().trim().min(1).max(100),
					color: z.string().optional(),
				})
				.parse(await request.json());
			return json(await createFolder(user, input));
		}
	}
	if (method === "GET" && path === "/api/messages") {
		const profile = await currentProfile(user);
		return json(
			await queryMessages(
				user,
				messageQuerySchema.parse({
					...Object.fromEntries(params),
					timeZone: getRequestTimeZone(request, profile.time_zone),
				}),
			),
		);
	}
	if (method === "GET" && path === "/api/messages/counts")
		return json({
			counts: await sourceCounts(user, params.get("mailboxId") ?? undefined),
		});
	if (method === "GET" && path === "/api/messages/navigation") {
		const folder = folderSchema.parse(params.get("folder"));
		const data = await queryMessages(
			user,
			{
				...folderInput(folder),
				mailboxId: params.get("mailboxId") ?? undefined,
				folderId: params.get("folderId") ?? undefined,
				group: params.get("group") === "thread" ? "thread" : undefined,
			},
			true,
		);
		return json({
			messages: data.messages.map((message) => ({
				id: message.id,
				unread:
					message.direction === "inbound" &&
					(message.threadUnread !== undefined
						? message.threadUnread > 0
						: !message.read),
			})),
		});
	}
	if (method === "POST" && path === "/api/messages/bulk")
		return json(
			await bulkAction(user, bulkActionSchema.parse(await request.json())),
		);
	if (method === "POST" && path === "/api/messages/empty") {
		const data = z
			.object({ mailboxId: z.string(), folder: z.enum(["trash", "spam"]) })
			.parse(await request.json());
		return json(await emptyFolder(user, data.mailboxId, data.folder));
	}
	const match =
		/^\/api\/messages\/([^/]+)(?:\/(thread|snooze|star|read|metadata))?$/.exec(
			path,
		);
	if (match) {
		const messageId = decodeURIComponent(match[1] ?? ""),
			action = match[2];
		if (method === "GET" && (!action || action === "metadata")) {
			const message = await messageRecord(user, messageId);
			const attachments = await withDatabase(
				(sql) =>
					sql.SourceDetailAttachments`SELECT id,message_id,filename,size,content_id,disposition,content_type FROM message_attachments WHERE message_id=${messageId} AND trashed_at IS NULL ORDER BY created_at,id`,
			);
			const [job] = await withDatabase(
				(sql) =>
					sql.SourceScheduledTime`SELECT scheduled_at FROM outbound_jobs WHERE message_id=${messageId} AND status='queued' AND scheduled_at IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
			);
			const raw = message.raw_r2_key
				? new LocalStorage().file(message.raw_r2_key)
				: null;
			const unsubscribeUrl =
				raw && (await raw.exists())
					? extractUnsubscribeUrlFromRaw(
							await raw.slice(0, 64 * 1024).arrayBuffer(),
						)
					: null;
			const files = attachments.map((file) => ({
				id: file.id,
				messageId: file.message_id,
				filename: file.filename,
				size: file.size,
				contentId: file.content_id,
				disposition: file.disposition,
				type: file.content_type,
			}));
			if (action === "metadata")
				return json({ attachments: files, unsubscribeUrl });
			const [enriched] = await messageContacts(message.user_id, [
				toMessage(message),
			]);
			return json({
				unsubscribeUrl,
				message: enriched,
				body: { textBody: message.text_body, htmlBody: message.html_body },
				attachments: attachments.map((file) => ({
					id: file.id,
					messageId: file.message_id,
					filename: file.filename,
					size: file.size,
					contentId: file.content_id,
					disposition: file.disposition,
					type: file.content_type,
				})),
				scheduledAt: iso(job?.scheduled_at),
			});
		}
		if (method === "GET" && action === "thread") {
			const record = await messageRecord(user, messageId),
				thread = await getThread(user, messageId);
			return json({
				threadId: record.thread_id,
				messages: await messageContacts(
					record.user_id,
					thread.map((message) => ({
						...toMessage(message),
						textBody: message.text_body,
						htmlBody: message.html_body,
						attachments: message.attachments.map((file) => ({
							id: file.id,
							messageId: file.message_id,
							filename: file.filename,
							size: file.size,
							contentId: file.content_id,
							disposition: file.disposition,
							type: file.content_type,
						})),
					})),
				),
			});
		}
		if (action === "star" && method === "POST")
			return json(await toggleStar(user, messageId));
		if (action === "snooze" && method === "POST") {
			const data = z
				.object({ snoozedUntil: z.iso.datetime() })
				.parse(await request.json());
			return json(await snooze(user, messageId, data.snoozedUntil));
		}
		if (action === "snooze" && method === "DELETE")
			return json(await snooze(user, messageId, null));
		if (action === "read" && method === "POST")
			return json(
				await bulkAction(user, { messageIds: [messageId], action: "read" }),
			);
	}
	return json({ error: "Not found" }, 404);
}
export async function serveMailApi(request: Request) {
	try {
		const publicDrive = await publicDriveApi(request);
		if (publicDrive) return publicDrive;
		const publicBooking = await publicBookingApi(request);
		if (publicBooking) return publicBooking;
		const authorization = request.headers.get("authorization") ?? "";
		if (
			isCalendarPath(new URL(request.url).pathname) &&
			(authorization.startsWith("Bearer ep_") ||
				authorization.startsWith("Basic "))
		) {
			const key = await authenticateApiKey(request);
			if (!key) throw new Response("Unauthorized", { status: 401 });
			const response = await calendarApi(request, key.user, key);
			return response ?? Response.json({ error: "Not found" }, { status: 404 });
		}
		const bearer = request.headers
			.get("authorization")
			?.match(/^Bearer (.+)$/)?.[1];
		const origin = request.headers.get("origin");
		if (
			!["GET", "HEAD", "OPTIONS"].includes(request.method) &&
			origin !== publicOrigin() &&
			(origin !== null || !bearer)
		)
			return Response.json({ error: "Invalid origin" }, { status: 403 });
		if (request.method === "GET") {
			const brand = await brandingApi(request);
			if (brand) return brand;
		}
		const bearerUser = bearer ? await getUser(bearer) : null;
		if (
			origin === null &&
			!["GET", "HEAD", "OPTIONS"].includes(request.method) &&
			bearer &&
			!bearerUser
		)
			throw new Response("Unauthorized", { status: 401 });
		const authResponse = await authApi(request);
		if (authResponse) return authResponse;
		const user = bearer ? bearerUser : await requireUser();
		if (!user) throw new Response("Unauthorized", { status: 401 });
		return await dispatchMailApi(request, user);
	} catch (error) {
		if (error instanceof Response)
			return Response.json(
				{ error: await error.text() },
				{ status: error.status },
			);
		if (error instanceof Error && error.message.startsWith("Too many"))
			return Response.json({ error: error.message }, { status: 429 });
		if (error instanceof Error && error.message === "Message too large")
			return Response.json(
				{ error: "Request body too large" },
				{ status: 413 },
			);
		if (error instanceof SyntaxError)
			return Response.json({ error: "Invalid JSON request" }, { status: 400 });
		if (error instanceof z.ZodError)
			return Response.json(
				{ error: "Invalid request", details: error.flatten() },
				{ status: 400 },
			);
		if (
			error instanceof Error &&
			/draft changed|another tab|no longer editable|is being saved/.test(
				error.message,
			)
		)
			return Response.json({ error: error.message }, { status: 409 });
		if (error instanceof Error && error.message === "Folder already exists")
			return Response.json({ error: error.message }, { status: 409 });
		if (
			error instanceof Error &&
			/not found or permission denied|Draft not found/.test(error.message)
		)
			return Response.json({ error: "Not found" }, { status: 404 });
		console.error("Mail API request failed", error);
		return Response.json({ error: "Request failed" }, { status: 500 });
	}
}
