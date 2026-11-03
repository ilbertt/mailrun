import type { User } from "../../shared/contracts";
import { withDatabase, seconds, type AppSQL } from "../db";
import { adminWrite } from "../admin/accounts";
import { keyActor } from "../auth/key-management";
import { OutboundProviderError } from "../mail/provider-error";
export async function assertResendKeyAdmin(sql: AppSQL, user: User) {
	try {
		await keyActor(sql, user, true);
	} catch (error) {
		if (error instanceof Response && error.status === 403)
			throw new Response(
				"Only the primary administrator can manage the Resend API key",
				{ status: 403 },
			);
		throw error;
	}
}
export async function resendKeyStatus(sql?: AppSQL): Promise<{
	configured: boolean;
	source: "settings" | "environment" | null;
	apiKey: string | null;
}> {
	if (!sql) return withDatabase(resendKeyStatus);
	const [row] =
		await sql.NativeResendCredentials`SELECT resend_api_key FROM app_settings WHERE id='default'`;
	const saved = row?.resend_api_key?.trim(),
		environment = process.env.RESEND_API_KEY?.trim();
	return {
		configured: !!(saved || environment),
		source: saved
			? ("settings" as const)
			: environment
				? ("environment" as const)
				: null,
		apiKey: saved || environment || null,
	};
}
export async function requireResendKey() {
	const { apiKey } = await resendKeyStatus();
	if (!apiKey)
		throw new OutboundProviderError(
			"Resend is selected but no API key is configured",
		);
	return apiKey;
}
export function saveResendKey(user: User, apiKey: string | null) {
	return adminWrite(async (sql) => {
		await assertResendKeyAdmin(sql, user);
		await sql.NativeSaveResendCredentials`INSERT INTO app_settings(id,resend_api_key,updated_at) VALUES('default',${apiKey},${seconds()}) ON CONFLICT(id) DO UPDATE SET resend_api_key=excluded.resend_api_key,updated_at=excluded.updated_at`;
		return resendKeyStatus(sql);
	});
}
export function resendWebhookSecret() {
	return withDatabase(async (sql) => {
		const [row] =
			await sql.NativeResendWebhookCredentials`SELECT resend_webhook_id,resend_webhook_secret FROM app_settings WHERE id='default'`;
		return row ?? null;
	});
}
export function storeResendWebhook(
	apiKey: string,
	id: string,
	secret: string,
	assertOwned: (sql: AppSQL) => Promise<void>,
) {
	return adminWrite(async (sql) => {
		await assertOwned(sql);
		if ((await resendKeyStatus(sql)).apiKey !== apiKey)
			throw new Error("Resend credentials changed. Try setup again.");
		await sql.NativeSaveResendWebhook`INSERT INTO app_settings(id,resend_webhook_id,resend_webhook_secret,updated_at) VALUES('default',${id},${secret},${seconds()}) ON CONFLICT(id) DO UPDATE SET resend_webhook_id=excluded.resend_webhook_id,resend_webhook_secret=excluded.resend_webhook_secret,updated_at=excluded.updated_at`;
	});
}
