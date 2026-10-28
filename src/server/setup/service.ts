import { z } from "zod";
import { withDatabase } from "../db";
import * as auth from "../auth/service";
import { timingSafeEqual } from "../auth/totp";
import { LocalStorage } from "../storage";
import { publicOrigin } from "../config";
import {
	cloudflareAccess,
	DomainCloudflare,
	normalizeHostname,
	MxConflictError,
} from "../domains/cloudflare";
import { domainOperation, domainActor } from "../domains/repository";
import { provisionEmail, deployEmailRelay } from "../cloudflare/setup";
import { ensureBookingUsername } from "../calendar/booking";
import type { CloudflareFetch } from "../cloudflare/client";
import type { User } from "../../shared/contracts";

export const firstRunRegistration = z.object({
	domain: z.string().min(3).max(253),
	username: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-zA-Z0-9._%+-]+$/)
		.transform((value) => value.toLowerCase()),
	password: z.string().min(8).max(256),
	resetEmail: z.email().transform((value) => value.toLowerCase().trim()),
	enableSending: z.boolean().default(true),
	replaceMxRecords: z.boolean().default(false),
	setupToken: z.string().max(256),
});
export function requireSetupToken(value: unknown) {
	const expected = process.env.SETUP_TOKEN;
	if (
		!expected ||
		expected.length < 16 ||
		typeof value !== "string" ||
		value.length > 256 ||
		!timingSafeEqual(expected, value)
	)
		throw new Response("Invalid setup token", { status: 403 });
}
export async function setupSnapshot() {
	return withDatabase(async (sql) => {
		const [admin] =
			await sql.NativeSetupAdmin`SELECT id FROM users WHERE role='admin' LIMIT 1`;
		const [domain] =
			await sql.NativePrimarySetupDomain`SELECT hostname,sending_requested FROM domains LIMIT 1`;
		return {
			hasAdminAccount: !!admin,
			hasPrimaryDomain: !!domain,
			primaryDomain: domain
				? {
						hostname: domain.hostname,
						sendingRequested: !!domain.sending_requested,
					}
				: null,
		};
	});
}
export async function setupChecks() {
	let storage = false;
	const key = "setup-probes/" + crypto.randomUUID(),
		store = new LocalStorage();
	try {
		await store.put(key, "setup");
		storage = (await store.file(key).text()) === "setup";
	} catch {
	} finally {
		await store.delete(key).catch(() => {});
	}
	const access = await cloudflareAccess();
	const database = await withDatabase(async (sql) => {
		await sql.NativeSetupDatabaseProbe`SELECT id FROM app_settings LIMIT 1`;
		return true;
	}).catch(() => false);
	return [
		{
			key: "Database",
			configured: database,
			message: "The local SQLite database must be available.",
		},
		{
			key: "Storage",
			configured: storage,
			message: "DATA_DIR must be writable.",
		},
		{
			key: "Cloudflare API credentials",
			configured: !!access?.apiToken && !!access.accountId,
			message:
				"Set CF_TOKEN and CF_ACCOUNT_ID for automatic email relay deployment.",
		},
		{
			key: "Public address",
			configured: publicOrigin().startsWith("https://"),
			message: "Set APP_URL to the public HTTPS address of this installation.",
		},
		{
			key: "SETUP_TOKEN",
			configured: (process.env.SETUP_TOKEN?.length ?? 0) >= 16,
			message: "Set SETUP_TOKEN to a random value of at least 16 characters.",
		},
	];
}
export async function setupDomainPreflight(
	value: string,
	send: CloudflareFetch = fetch,
) {
	const hostname = normalizeHostname(value),
		access = await cloudflareAccess();
	if (!access?.apiToken || !access.accountId)
		throw new Response(
			"Set CF_TOKEN and CF_ACCOUNT_ID before connecting email",
			{ status: 503 },
		);
	const api = new DomainCloudflare(access, send),
		zone = await api.findZone(hostname);
	if (!zone)
		throw new Response(
			`Zone not found for "${hostname}". The domain must use Cloudflare DNS on this account.`,
			{ status: 502 },
		);
	return { domain: { hostname, zone: { id: zone.id, name: zone.name } }, api };
}

/** Install the email-only Worker before the original onboarding/domain controls run. */
export async function ensureSetupRelay(
	user: User,
	hostname: string,
	send: CloudflareFetch = fetch,
) {
	await withDatabase((sql) => domainActor(sql, user, true));
	const access = await cloudflareAccess();
	if (access?.workerName) return;
	if (!user.isPrimaryAdmin)
		throw new Response(
			"Only the primary administrator can configure the email relay",
			{ status: 403 },
		);
	if (!access?.accountId)
		throw new Response(
			"Set CF_TOKEN and CF_ACCOUNT_ID before connecting email",
			{ status: 503 },
		);
	await deployEmailRelay(
		user,
		{ hostname, accountId: access.accountId, apiToken: access.apiToken },
		send,
	);
}

export async function registerWorkspace(
	value: unknown,
	send: CloudflareFetch = fetch,
) {
	const data = firstRunRegistration.parse(value);
	requireSetupToken(data.setupToken);
	return domainOperation("initial-setup", async (assertOwned) => {
		if ((await setupSnapshot()).hasAdminAccount)
			throw new Response(
				"Registration is closed after the first account is created",
				{ status: 403 },
			);
		const { domain, api } = await setupDomainPreflight(data.domain, send);
		// Preflight the explicit MX consent before publishing even a temporary account.
		const foreign = await api.foreignMx(domain.zone.id, domain.hostname);
		if (foreign.length && !data.replaceMxRecords) {
			throw new MxConflictError(
				foreign.map((row) => ({
					content: row.content ?? "",
					priority: row.priority ?? 0,
				})),
			);
		}
		const access = api.access;
		if (!access.accountId)
			throw new Response("Cloudflare account is required", { status: 503 });
		await withDatabase(assertOwned);
		const user = await auth.claimAdministrator({
			email: `${data.username}@${domain.hostname}`,
			name: data.username,
			password: data.password,
			setupToken: data.setupToken,
		});
		try {
			await withDatabase(
				(sql) =>
					sql.NativeSetupRecoveryEmail`UPDATE users SET reset_email=${data.resetEmail} WHERE id=${user.id}`,
			);
			await ensureBookingUsername(user);
			await provisionEmail(
				user,
				{
					accountId: access.accountId,
					apiToken: access.apiToken,
					hostname: domain.hostname,
					localPart: data.username,
					activateRouting: true,
					enableSending: data.enableSending,
					replaceMxRecords: data.replaceMxRecords,
				},
				send,
			);
			await withDatabase(assertOwned);
			return { ok: true, redirect: "/login" };
		} catch (error) {
			// Keep the reusable Worker identity/secret, but do not leave an unusable
			// first account or its domain/mailbox after a failed provisioning attempt.
			await withDatabase(async (sql) => {
				await assertOwned(sql);
				await sql.NativeRollbackSetupAccount`DELETE FROM users WHERE id=${user.id}`;
			});
			throw error;
		}
	});
}
