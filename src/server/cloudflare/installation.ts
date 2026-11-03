import { relayVersion } from "../../generated/relay";
import { withDatabase, seconds } from "../db";
import type { CloudflareAuth } from "../../shared/cloudflare-auth";
import { cloudflareCredentialColumns } from "./credentials";

export async function getInstallation() {
	return withDatabase(
		async (sql) =>
			(
				await sql.GetInstallation`SELECT * FROM mailrun_installation WHERE id='primary'`
			)[0] ?? null,
	);
}
export async function saveInstallation(input: {
	accountId: string;
	zoneId: string;
	hostname: string;
	workerName: string;
	publicOrigin: string;
	auth: CloudflareAuth;
	relaySecret: string;
	relayVersion: string;
}) {
	const credentials = cloudflareCredentialColumns(input.auth);
	await withDatabase(
		(sql) => sql.SaveInstallation`
		INSERT INTO mailrun_installation (id,account_id,zone_id,hostname,worker_name,public_origin,api_token,api_key,api_email,relay_secret,relay_version,phase,updated_at)
		VALUES ('primary',${input.accountId},${input.zoneId},${input.hostname},${input.workerName},${input.publicOrigin},${credentials.apiToken},${credentials.apiKey},${credentials.apiEmail},${input.relaySecret},${input.relayVersion},'saved',${seconds()})
		ON CONFLICT(id) DO UPDATE SET hostname=CASE WHEN mailrun_installation.phase='saved' THEN excluded.hostname ELSE mailrun_installation.hostname END,zone_id=CASE WHEN mailrun_installation.phase='saved' THEN excluded.zone_id ELSE mailrun_installation.zone_id END,api_token=excluded.api_token,api_key=excluded.api_key,api_email=excluded.api_email,public_origin=excluded.public_origin,relay_version=excluded.relay_version,updated_at=excluded.updated_at`,
	);
}
export async function setInstallationPhase(
	phase: "saved" | "deployed" | "ready",
) {
	await withDatabase(
		(sql) =>
			sql.SetInstallationPhase`UPDATE mailrun_installation SET phase=${phase},updated_at=${seconds()} WHERE id='primary'`,
	);
}
export async function installationStatus() {
	const installation = await getInstallation();
	return installation
		? {
				hostname: installation.hostname,
				workerName: installation.worker_name,
				phase: installation.phase,
				needsRelayUpdate: installation.relay_version !== relayVersion,
			}
		: null;
}
