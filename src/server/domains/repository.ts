import { z } from "zod";
import type { User } from "../../shared/contracts";
import { withDatabase, id, seconds, type AppSQL } from "../db";
const provider = z.enum(["none", "cloudflare", "resend", "ses"]);
const row = z.object({
	id: z.string(),
	user_id: z.string(),
	hostname: z.string(),
	zone_id: z.string(),
	status: z.string(),
	routing_status: z.string().nullable(),
	sending_subdomain_tag: z.string().nullable(),
	sending_enabled: z.number(),
	routing_enabled: z.number(),
	sending_requested: z.number(),
	sending_provider: provider,
	receiving_provider: provider,
	created_at: z.number(),
});
export type DomainRecord = z.infer<typeof row>;
export const domainRecord = (value: unknown) => row.parse(value);
export function domainDto(value: DomainRecord) {
	return {
		id: value.id,
		userId: value.user_id,
		hostname: value.hostname,
		zoneId: value.zone_id,
		status: value.status,
		routingStatus: value.routing_status,
		sendingSubdomainTag: value.sending_subdomain_tag,
		sendingEnabled: !!value.sending_enabled,
		routingEnabled: !!value.routing_enabled,
		sendingRequested: !!value.sending_requested,
		sendingProvider: value.sending_provider,
		receivingProvider: value.receiving_provider,
		createdAt: new Date(value.created_at * 1000).toISOString(),
	};
}
export async function domainActor(sql: AppSQL, user: User, mutation = false) {
	const [actor] =
		await sql.NativeDomainActor`SELECT id,role,is_primary_admin,disabled,can_manage_domains,can_manage_mailboxes,created_by_user_id FROM users WHERE id=${user.id}`;
	if (!actor || actor.disabled)
		throw new Response("Unauthorized", { status: 401 });
	if (
		mutation &&
		!(
			actor.role === "admin" &&
			(actor.is_primary_admin || actor.can_manage_domains)
		)
	)
		throw new Response("Forbidden", { status: 403 });
	return actor;
}
export async function ownedDomain(
	sql: AppSQL,
	user: User,
	domainId: string,
	mutation = false,
) {
	await domainActor(sql, user, mutation);
	const [domain] =
		await sql.NativeDomainById`SELECT * FROM domains WHERE id=${domainId} AND user_id=${user.id}`;
	if (!domain) throw new Response("Not found", { status: 404 });
	return domainRecord(domain);
}
export async function domainWrite<T>(run: (sql: AppSQL) => Promise<T>) {
	return withDatabase((sql) =>
		sql.begin(async (tx) => {
			await tx.NativeDomainWriteFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
			return run(tx);
		}),
	);
}
export async function checkDomainClaim(
	sql: AppSQL,
	user: User,
	hostname: string,
	zoneId: string,
) {
	await domainActor(sql, user, true);
	const rows =
		await sql.NativeDomainClaims`SELECT id,user_id,hostname FROM domains WHERE hostname=${hostname} OR zone_id=${zoneId}`;
	if (rows.some((row) => row.user_id !== user.id))
		throw new Response(
			"Cloudflare zone is already registered to another account",
			{ status: 409 },
		);
	return rows.find((row) => row.hostname === hostname) ?? null;
}
export async function clearDomainRuntimeLeases() {
	await withDatabase(
		(sql) =>
			sql.NativeClearDomainRuntimeLeases`DELETE FROM mailrun_job_leases WHERE name LIKE 'domain:%'`,
	);
}
export async function domainOperation<T>(
	zoneId: string,
	run: (assertOwned: (sql: AppSQL) => Promise<void>) => Promise<T>,
) {
	const name = "domain:" + zoneId,
		owner = id("domain-lock");
	const [lease] = await withDatabase(
		(sql) =>
			sql.NativeClaimDomainOperation`INSERT INTO mailrun_job_leases(name,owner,expires_at) VALUES(${name},${owner},${seconds() + 120}) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE mailrun_job_leases.expires_at<${seconds()} RETURNING owner`,
	);
	if (!lease)
		throw new Response("This domain is being updated. Try again shortly.", {
			status: 409,
		});
	let lost = false;
	const heartbeat = setInterval(() => {
		void withDatabase(
			(sql) =>
				sql.NativeRenewDomainOperation`UPDATE mailrun_job_leases SET expires_at=${seconds() + 120} WHERE name=${name} AND owner=${owner} RETURNING owner`,
		)
			.then((rows) => {
				if (!rows.length) lost = true;
			})
			.catch(() => {
				lost = true;
			});
	}, 30000);
	try {
		return await run(async (sql) => {
			const [row] =
				await sql.NativeCheckDomainOperation`SELECT owner FROM mailrun_job_leases WHERE name=${name} AND owner=${owner} AND expires_at>=${seconds()}`;
			if (lost || !row)
				throw new Response("Domain setup changed. Try again.", { status: 409 });
		});
	} finally {
		clearInterval(heartbeat);
		await withDatabase(
			(sql) =>
				sql.NativeReleaseDomainOperation`DELETE FROM mailrun_job_leases WHERE name=${name} AND owner=${owner}`,
		);
	}
}
