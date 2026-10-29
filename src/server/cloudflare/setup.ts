import { cloudflareCredentials } from "./credentials";
import { DomainCloudflare } from "../domains/cloudflare";
import { domainOperation, checkDomainClaim } from "../domains/repository";
import {
	provisionCloudflareDomain,
	rollbackCloudflareDomain,
} from "../domains/provision";
import { signRelay } from "../../shared/relay-signature";
import { z } from "zod";
import { cloudflare, CloudflareApiError, type CloudflareFetch } from "./client";
import {
	getInstallation,
	installationStatus,
	saveInstallation,
	setInstallationPhase,
} from "./installation";
import { publicOrigin } from "../config";
import { withDatabase, id, seconds } from "../db";
import { relaySource, relayVersion } from "../../generated/relay";
import { setupCloudflareSchema, type User } from "../../shared/contracts";

export class RelayDeploymentError extends Error {}

export async function provisionEmail(
	user: User,
	input: z.input<typeof setupCloudflareSchema>,
	request: CloudflareFetch = fetch,
) {
	const data = setupCloudflareSchema.parse(input);
	const { zone, worker } = await deployEmailRelay(user, data, request);

	// The app owns only records for this installation. Provisioning never deletes
	// MX records or silently replaces an existing domain owned by another user.
	await withDatabase((sql) =>
		sql.begin(async (tx) => {
			await tx.NativeSetupWriteFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
			await checkDomainClaim(tx, user, data.hostname, zone.id);
			const [domain] =
				await tx.SetupDomain`SELECT id,user_id FROM domains WHERE hostname=${data.hostname}`;
			if (domain && domain.user_id !== user.id)
				throw new Error("Domain belongs to another account");
			const domainId = domain?.id ?? id("dom");
			await tx.InsertSetupDomain`
			INSERT INTO domains (id,user_id,hostname,zone_id,status,created_at)
			VALUES (${domainId},${user.id},${data.hostname},${zone.id},'pending',${seconds()})
			ON CONFLICT(hostname) DO UPDATE SET zone_id=excluded.zone_id WHERE domains.user_id=excluded.user_id`;
			await tx.InsertSetupMailbox`
			INSERT INTO mailboxes (id,user_id,domain_id,local_part,display_name,created_at)
			VALUES (${id("mb")},${user.id},${domainId},${data.localPart},${user.name},${seconds()})
			ON CONFLICT(domain_id,local_part) DO NOTHING`;
		}),
	);
	if (data.activateRouting) {
		const api = new DomainCloudflare(
			{
				apiToken: data.apiToken,
				accountId: data.accountId,
				workerName: worker,
			},
			request,
		);
		await domainOperation(zone.id, async (assertOwned) => {
			const provisioned = await provisionCloudflareDomain(api, data.hostname, {
				enableRouting: true,
				enableSending: data.enableSending,
				replaceMxRecords: data.replaceMxRecords,
				zone,
			});
			try {
				await withDatabase((sql) =>
					sql.begin(async (tx) => {
						await tx.NativeSetupFinishFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
						await assertOwned(tx);
						const active =
							await tx.ActivateDomain`UPDATE domains SET routing_enabled=${provisioned.routingEnabled ? 1 : 0},status=${provisioned.routingEnabled || provisioned.sendingEnabled ? "active" : "pending"},routing_status=${provisioned.routingStatus ?? null} WHERE hostname=${data.hostname} AND user_id=${user.id} RETURNING id`;
						if (!active.length)
							throw new Error(
								"Domain changed during setup. Retry before routing mail.",
							);
						await tx.EnableSending`UPDATE domains SET sending_provider=${data.enableSending ? "cloudflare" : "none"},sending_enabled=${provisioned.sendingEnabled ? 1 : 0},sending_requested=${data.enableSending ? 1 : 0},sending_subdomain_tag=${provisioned.sendingSubdomainTag} WHERE hostname=${data.hostname} AND user_id=${user.id}`;
					}),
				);
			} catch (error) {
				const failures = await rollbackCloudflareDomain(
					api,
					provisioned.changes,
				);
				if (failures.length)
					throw new AggregateError(
						[error, ...failures],
						"Email setup failed and cleanup could not finish. Check Cloudflare routing before retrying.",
					);
				throw error;
			}
			await setInstallationPhase(
				provisioned.routingEnabled ? "ready" : "deployed",
			);
		});
	}

	return installationStatus();
}

export async function deployEmailRelay(
	user: User,
	input: { accountId: string; hostname: string; apiToken: string },
	request: CloudflareFetch = fetch,
) {
	if (!user.isPrimaryAdmin)
		throw new Error("Only the primary administrator can configure email");
	const data = setupCloudflareSchema
		.pick({ accountId: true, hostname: true, apiToken: true })
		.parse(input);
	const origin = publicOrigin();
	if (!origin.startsWith("https://"))
		throw new RelayDeploymentError(
			"Set APP_URL to the application's public HTTPS address before deploying the relay",
		);
	const existing = await getInstallation();
	if (
		existing &&
		(existing.hostname !== data.hostname ||
			existing.account_id !== data.accountId)
	)
		throw new Error("This installation is already connected to another domain");
	const [claimedHostname] = await withDatabase(
		(sql) =>
			sql.NativeSetupHostnameClaim`SELECT user_id FROM domains WHERE hostname=${data.hostname}`,
	);
	if (claimedHostname && claimedHostname.user_id !== user.id)
		throw new Error("Domain belongs to another account");
	const zone = await new DomainCloudflare(
		{ apiToken: data.apiToken, accountId: data.accountId, workerName: null },
		request,
	).findZone(data.hostname);
	if (!zone)
		throw new Error("Domain not found in the selected Cloudflare account");
	const [claimedZone] = await withDatabase(
		(sql) =>
			sql.NativeSetupZoneClaim`SELECT user_id FROM domains WHERE zone_id=${zone.id} AND user_id<>${user.id} LIMIT 1`,
	);
	if (claimedZone)
		throw new Error("Cloudflare zone belongs to another account");
	const secret =
		existing?.relay_secret ?? crypto.randomUUID() + crypto.randomUUID();
	const worker =
		existing?.worker_name ?? `mailrun-${crypto.randomUUID().slice(0, 12)}`;
	await saveInstallation({
		...data,
		zoneId: zone.id,
		workerName: worker,
		publicOrigin: origin,
		relaySecret: secret,
		relayVersion: existing?.relay_version ?? "",
	});

	await refreshRelay(user, request);
	await setInstallationPhase("deployed");

	return { zone, worker };
}

export async function refreshRelay(
	user: User,
	request: CloudflareFetch = fetch,
) {
	if (!user.isPrimaryAdmin)
		throw new Error("Only the primary administrator can update the relay");
	const installation = await getInstallation();
	if (!installation) throw new Error("Email is not configured");
	const { apiToken } = cloudflareCredentials(installation);
	if (!apiToken)
		throw new RelayDeploymentError(
			"Set CF_TOKEN before deploying the email relay",
		);
	const worker = installation.worker_name,
		secret = installation.relay_secret,
		origin = publicOrigin();
	if (!origin.startsWith("https://"))
		throw new RelayDeploymentError(
			"APP_URL must use HTTPS before deploying the relay",
		);
	const timestamp = String(Date.now()),
		probe = await request(`${origin}/api/relay-health`, {
			method: "POST",
			headers: {
				"X-Mailrun-Timestamp": timestamp,
				"X-Mailrun-Signature": await signRelay(
					secret,
					timestamp,
					"",
					"",
					new Uint8Array(),
				),
			},
			signal: AbortSignal.timeout(30000),
		});
	const reachable =
		probe.ok &&
		z
			.object({ ok: z.literal(true) })
			.safeParse(await probe.json().catch(() => null)).success;
	if (!reachable)
		throw new RelayDeploymentError(
			"Mailrun could not reach its public address before deploying the relay. Check APP_URL and retry.",
		);
	const accountSubdomain = await ensureWorkersSubdomain(
		installation.account_id,
		apiToken,
		request,
	);
	const form = new FormData();
	form.set(
		"metadata",
		JSON.stringify({
			main_module: "relay.js",
			compatibility_date: "2026-05-20",
			bindings: [
				{ type: "plain_text", name: "MAILRUN_URL", text: origin },
				{ type: "secret_text", name: "RELAY_SECRET", text: secret },
			],
		}),
	);
	form.set(
		"relay.js",
		new Blob([relaySource], { type: "application/javascript+module" }),
		"relay.js",
	);
	await cloudflare(
		apiToken,
		`/accounts/${installation.account_id}/workers/scripts/${worker}`,
		z.unknown(),
		{ method: "PUT", body: form },
		request,
	);
	await cloudflare(
		apiToken,
		`/accounts/${installation.account_id}/workers/scripts/${worker}/subdomain`,
		z.unknown(),
		{ method: "POST", body: JSON.stringify({ enabled: true }) },
		request,
	);

	await waitForRelayHealth(
		`https://${worker}.${accountSubdomain.subdomain}.workers.dev/health`,
		secret,
		request,
	);

	await withDatabase(
		(sql) =>
			sql.UpdateRelayVersion`UPDATE mailrun_installation SET relay_version=${relayVersion},api_token=${apiToken},public_origin=${origin},updated_at=${seconds()} WHERE id='primary'`,
	);
	return installationStatus();
}

export async function waitForRelayHealth(
	url: string,
	secret: string,
	request: CloudflareFetch = fetch,
) {
	const deadline = Date.now() + 30_000;
	let status: number | null = null;
	for (let attempt = 0; attempt < 6 && Date.now() < deadline; attempt++) {
		if (attempt)
			await Bun.sleep(
				Math.min(100 * 2 ** (attempt - 1), deadline - Date.now()),
			);
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		try {
			const response = await request(url, {
				headers: { Authorization: `Bearer ${secret}` },
				signal: AbortSignal.timeout(Math.min(5_000, remaining)),
			});
			status = response.status;
			if (response.ok) {
				const body: unknown = await response.json().catch(() => null);
				if (z.object({ ok: z.literal(true) }).safeParse(body).success) return;
			} else await response.body?.cancel();
			if (status === 401 || status === 403) break;
		} catch {
			status = null;
		}
	}
	throw new RelayDeploymentError(
		`Relay deployed, but could not reach Mailrun${status == null ? "" : ` (HTTP ${status})`}. Check APP_URL and retry.`,
	);
}

async function ensureWorkersSubdomain(
	accountId: string,
	token: string,
	request: CloudflareFetch,
) {
	const schema = z.object({ subdomain: z.string().regex(/^[a-z0-9-]+$/) }),
		path = `/accounts/${accountId}/workers/subdomain`;
	try {
		return await cloudflare(token, path, schema, {}, request);
	} catch (error) {
		if (!(error instanceof CloudflareApiError) || error.status !== 404)
			throw error;
		return cloudflare(
			token,
			path,
			schema,
			{
				method: "PUT",
				body: JSON.stringify({ subdomain: `mailrun-${accountId}` }),
			},
			request,
		);
	}
}
