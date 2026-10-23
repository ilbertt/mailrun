import { z } from "zod";
import { cloudflare, type CloudflareFetch } from "./client";
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

export async function provisionEmail(
	user: User,
	input: z.infer<typeof setupCloudflareSchema>,
	request: CloudflareFetch = fetch,
) {
	if (!user.isPrimaryAdmin)
		throw new Error("Only the primary administrator can configure email");
	const data = setupCloudflareSchema.parse(input);
	const origin = publicOrigin();
	if (!origin.startsWith("https://"))
		throw new Error(
			"Set APP_URL to the application's public HTTPS address before deploying the relay",
		);
	const zones = await cloudflare(
		data.apiToken,
		`/zones?name=${encodeURIComponent(data.hostname)}`,
		z.array(
			z.object({
				id: z.string(),
				name: z.string(),
				account: z.object({ id: z.string() }),
			}),
		),
		{},
		request,
	);
	const zone = zones.find(
		(zone) => zone.name === data.hostname && zone.account.id === data.accountId,
	);
	if (!zone)
		throw new Error("Domain not found in the selected Cloudflare account");
	const existing = await getInstallation();
	if (
		existing &&
		(existing.hostname !== data.hostname ||
			existing.account_id !== data.accountId)
	)
		throw new Error("This installation is already connected to another domain");
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

	// The app owns only records for this installation. Provisioning never deletes
	// MX records or silently replaces an existing domain owned by another user.
	await withDatabase(async (sql) => {
		const [domain] =
			await sql.SetupDomain`SELECT id,user_id FROM domains WHERE hostname=${data.hostname}`;
		if (domain && domain.user_id !== user.id)
			throw new Error("Domain belongs to another account");
		const domainId = domain?.id ?? id("dom");
		await sql.InsertSetupDomain`
			INSERT INTO domains (id,user_id,hostname,zone_id,status,created_at)
			VALUES (${domainId},${user.id},${data.hostname},${zone.id},'pending',${seconds()})
			ON CONFLICT(hostname) DO NOTHING`;
		await sql.InsertSetupMailbox`
			INSERT INTO mailboxes (id,user_id,domain_id,local_part,display_name,created_at)
			VALUES (${id("mb")},${user.id},${domainId},${data.localPart},${user.name},${seconds()})
			ON CONFLICT(domain_id,local_part) DO NOTHING`;
	});
	if (data.activateRouting) {
		await cloudflare(
			data.apiToken,
			`/zones/${zone.id}/email/routing/dns`,
			z.unknown(),
			{ method: "POST" },
			request,
		);
		await cloudflare(
			data.apiToken,
			`/zones/${zone.id}/email/routing/rules/catch_all`,
			z.unknown(),
			{
				method: "PUT",
				body: JSON.stringify({
					enabled: true,
					name: `Mailrun ${worker}`,
					matchers: [{ type: "all" }],
					actions: [{ type: "worker", value: [worker] }],
				}),
			},
			request,
		);
		await withDatabase(
			(sql) =>
				sql.ActivateDomain`UPDATE domains SET routing_enabled=1,status='active',routing_status='enabled' WHERE hostname=${data.hostname}`,
		);
		const sendingSchema = z.object({
			tag: z.string(),
			name: z.string(),
			enabled: z.boolean(),
		});
		const sendingDomains = await cloudflare(
			data.apiToken,
			`/zones/${zone.id}/email/sending/subdomains`,
			z.array(sendingSchema),
			{},
			request,
		);
		const sending =
			sendingDomains.find((domain) => domain.name === data.hostname) ??
			(await cloudflare(
				data.apiToken,
				`/zones/${zone.id}/email/sending/subdomains`,
				sendingSchema,
				{ method: "POST", body: JSON.stringify({ name: data.hostname }) },
				request,
			));
		await withDatabase(
			(sql) => sql.EnableSending`
			UPDATE domains SET sending_provider='cloudflare',sending_enabled=${sending.enabled ? 1 : 0},sending_requested=1,sending_subdomain_tag=${sending.tag}
			WHERE hostname=${data.hostname}`,
		);
		await setInstallationPhase("ready");
	}
	return installationStatus();
}

export async function refreshRelay(
	user: User,
	request: CloudflareFetch = fetch,
) {
	if (!user.isPrimaryAdmin)
		throw new Error("Only the primary administrator can update the relay");
	const installation = await getInstallation();
	if (!installation) throw new Error("Email is not configured");
	const worker = installation.worker_name,
		secret = installation.relay_secret,
		origin = publicOrigin();
	if (!origin.startsWith("https://"))
		throw new Error("APP_URL must use HTTPS before deploying the relay");
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
		installation.api_token,
		`/accounts/${installation.account_id}/workers/scripts/${worker}`,
		z.unknown(),
		{ method: "PUT", body: form },
		request,
	);
	await cloudflare(
		installation.api_token,
		`/accounts/${installation.account_id}/workers/scripts/${worker}/subdomain`,
		z.unknown(),
		{ method: "POST", body: JSON.stringify({ enabled: true }) },
		request,
	);
	const accountSubdomain = await cloudflare(
		installation.api_token,
		`/accounts/${installation.account_id}/workers/subdomain`,
		z.object({ subdomain: z.string().regex(/^[a-z0-9-]+$/) }),
		{},
		request,
	);
	const health = await request(
		`https://${worker}.${accountSubdomain.subdomain}.workers.dev/health`,
		{
			headers: { Authorization: `Bearer ${secret}` },
			signal: AbortSignal.timeout(30_000),
		},
	);
	if (!health.ok)
		throw new Error(
			"Relay deployed, but could not reach Mailrun. Check APP_URL and retry.",
		);

	await withDatabase(
		(sql) =>
			sql.UpdateRelayVersion`UPDATE mailrun_installation SET relay_version=${relayVersion},public_origin=${origin},updated_at=${seconds()} WHERE id='primary'`,
	);
	return installationStatus();
}
