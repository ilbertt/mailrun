import { z } from "zod";
import { withDatabase, seconds } from "./db";
import {
	hashLicenseKey,
	normalizeLicensePlan,
	parseFeatures,
	parsePaymugLicenseResponse,
} from "../lib/licenses/utils";
import { LICENSE_PRODUCT_IDS } from "../lib/licenses/constants";
import type {
	LicenseEntitlements,
	LicensePlan,
	LicenseStatus,
	PaymugLicenseAction,
} from "../lib/licenses/types";
async function readSettings() {
	return withDatabase(
		async (sql) =>
			(
				await sql.ReadLicenseSettings`SELECT * FROM license_settings WHERE id='default'`
			)[0],
	);
}
async function settings() {
	let row = await readSettings();
	if (!row) {
		await withDatabase(
			(sql) =>
				sql.CreateLicenseSettings`INSERT INTO license_settings (id,instance_id,updated_at) VALUES ('default',${crypto.randomUUID()},${seconds()}) ON CONFLICT(id) DO NOTHING`,
		);
		row = await readSettings();
	}
	if (!row) throw new Error("Unable to initialize license settings");
	return row;
}
export async function licenseStatus(): Promise<LicenseStatus> {
	const row = await settings(),
		active =
			row.state === "active" && (row.plan === "pro" || row.plan === "team");
	return {
		plan:
			active && row.plan === "pro"
				? "pro"
				: active && row.plan === "team"
					? "team"
					: "community",
		state: z
			.enum(["inactive", "active", "invalid", "expired", "deactivated"])
			.parse(row.state),
		features: parseFeatures(row.features),
		seatLimit: active && row.plan === "pro" ? row.seat_limit : null,
		instanceId: row.instance_id,
		instanceUrl: row.instance_url,
		active,
		activatedAt:
			row.activated_at == null ? null : new Date(row.activated_at * 1000),
		validatedAt:
			row.validated_at == null ? null : new Date(row.validated_at * 1000),
	};
}
export async function licenseEntitlements(): Promise<LicenseEntitlements> {
	const status = await licenseStatus();
	return {
		plan: status.plan,
		canCustomizeBranding: status.active,
		canManageAccounts: status.active,
		canShareMailboxes: status.active && status.plan === "team",
		accountSeatLimit: status.seatLimit,
		canForwardEmail: status.active,
	};
}
export type LicenseFetch = (
	url: string,
	init: RequestInit,
) => Promise<Response>;
export async function updateLicense(
	action: PaymugLicenseAction,
	key: string,
	instanceUrl: string,
	requestedPlan?: Exclude<LicensePlan, "community">,
	request: LicenseFetch = fetch,
) {
	const row = await settings(),
		keyHash = key ? await hashLicenseKey(key) : null;
	if (action === "validate" && (!keyHash || row.license_key_hash !== keyHash))
		throw new Error("This key does not match the activated license");
	const plan =
		action === "activate"
			? requestedPlan
			: row.plan === "pro" || row.plan === "team"
				? row.plan
				: null;
	if (!plan) throw new Error("Choose the license product to activate");
	const input =
		action === "deactivate"
			? { productId: LICENSE_PRODUCT_IDS[plan], instanceId: row.instance_id }
			: {
					licenseKey: key,
					productId: LICENSE_PRODUCT_IDS[plan],
					instanceId: row.instance_id,
					instanceUrl:
						action === "activate"
							? instanceUrl
							: (row.instance_url ?? instanceUrl),
					appVersion: "0.5.2",
				};
	let response: Response;
	try {
		response = await request(
			`https://app.paymug.co/api/v1/licenses/${action}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(input),
				signal: AbortSignal.timeout(15000),
			},
		);
	} catch {
		throw new Error("Unable to reach Paymug. Try again later.");
	}
	if (!response.ok)
		throw new Error(
			response.status === 409
				? "This license is active on another installation. Deactivate it there before retrying."
				: response.status === 401 || response.status === 403
					? "Paymug rejected this license key."
					: response.status >= 500
						? "Paymug is temporarily unavailable. Try again later."
						: "Paymug could not process this license request.",
		);
	const result = parsePaymugLicenseResponse(await response.json());
	if (action === "deactivate") {
		if (result.state !== "deactivated")
			throw new Error("Paymug did not confirm deactivation");
		await withDatabase(
			(sql) =>
				sql.DeactivateLicense`UPDATE license_settings SET license_key_hash=NULL,plan='community',state='deactivated',features='[]',seat_limit=1,validated_at=${seconds()},updated_at=${seconds()} WHERE id='default'`,
		);
		return licenseStatus();
	}
	const responsePlan = normalizeLicensePlan(result.productId, result.plan);
	if (
		!result.valid ||
		result.state !== "active" ||
		(!!result.productId && responsePlan !== plan)
	) {
		if (action === "validate")
			await withDatabase(
				(sql) =>
					sql.InvalidateLicense`UPDATE license_settings SET state=${result.state === "active" ? "invalid" : result.state},validated_at=${seconds()},updated_at=${seconds()} WHERE id='default'`,
			);
		throw new Error(
			result.state === "expired"
				? "This license has expired"
				: "This license is not valid for this installation",
		);
	}
	await withDatabase(
		(sql) =>
			sql.ActivateLicense`UPDATE license_settings SET license_key_hash=${keyHash ?? row.license_key_hash},instance_url=${action === "activate" ? instanceUrl : row.instance_url},instance_id=${result.instanceId ?? row.instance_id},plan=${plan},state='active',features=${JSON.stringify(result.features ?? [])},seat_limit=${result.seatLimit === undefined ? row.seat_limit : result.seatLimit},activated_at=${action === "activate" ? seconds() : row.activated_at},validated_at=${seconds()},updated_at=${seconds()} WHERE id='default'`,
	);
	return licenseStatus();
}
