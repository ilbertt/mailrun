import type { User } from "../../shared/contracts";
import { addDomainSchema } from "../../lib/validators";
import { withDatabase, id, seconds, type AppSQL } from "../db";
import {
	DomainCloudflare,
	cloudflareAccess,
	normalizeHostname,
	findSendingSubdomain,
	isCloudflareMx,
	MxConflictError,
	type SendingSubdomain,
} from "./cloudflare";
import {
	domainActor,
	ownedDomain,
	domainOperation,
	domainWrite,
	checkDomainClaim,
	domainRecord,
	domainDto,
	type DomainRecord,
} from "./repository";
import {
	provisionCloudflareDomain,
	rollbackCloudflareDomain,
} from "./provision";
import { domainDns, summarizeDomainDns, type DnsLookup } from "./dns";
export async function requireDomainClient() {
	const credentials = await cloudflareAccess();
	if (!credentials)
		throw new Response(
			"Configure Cloudflare email during setup before managing DNS",
			{ status: 503 },
		);
	return new DomainCloudflare(credentials);
}
export async function preflightDomain(
	user: User,
	value: string,
	client?: DomainCloudflare,
) {
	await withDatabase((sql) => domainActor(sql, user));
	const hostname = normalizeHostname(value),
		api = client ?? (await requireDomainClient()),
		zone = await api.findZone(hostname);
	if (!zone)
		throw new Response(
			`Zone not found for "${hostname}". The domain must use Cloudflare DNS on this account.`,
			{ status: 502 },
		);
	return { hostname, zone: { id: zone.id, name: zone.name } };
}
export async function listDomains(
	user: User,
	includeDns = false,
	client?: DomainCloudflare,
	lookup?: DnsLookup,
) {
	const rows = await withDatabase(async (sql) => {
		const actor = await domainActor(sql, user),
			owner =
				actor.can_manage_mailboxes && actor.created_by_user_id
					? actor.created_by_user_id
					: user.id;
		return sql.NativeDomainsForUser`SELECT * FROM domains WHERE user_id=${owner}`;
	});
	const domains = rows.map(domainRecord);
	if (!includeDns) return { domains: domains.map(domainDto) };
	const api = client ?? (await requireDomainClient().catch(() => null));
	if (!api && !domains.some((domain) => domain.zone_id === "manual"))
		return { domains: domains.map(domainDto), dns: {} };
	const results: PromiseSettledResult<{
		domain: DomainRecord;
		view: Awaited<ReturnType<typeof domainDns>>;
	}>[] = [];
	for (let offset = 0; offset < domains.length; offset += 4)
		results.push(
			...(await Promise.allSettled(
				domains.slice(offset, offset + 4).map(async (domain) => ({
					domain,
					view: await domainDns(api, domain, lookup),
				})),
			)),
		);

	const views = results.flatMap((result) =>
			result.status === "fulfilled" ? [result.value] : [],
		),
		byId = new Map(views.map((value) => [value.domain.id, value.view]));
	return {
		domains: domains.map((domain) => ({
			...domainDto(domain),
			sendingEnabled:
				byId.get(domain.id)?.sendingEnabled ?? !!domain.sending_enabled,
		})),
		dns: Object.fromEntries(
			views.map(({ domain, view }) => [
				domain.id,
				summarizeDomainDns(view, domain),
			]),
		),
	};
}
export async function getDomain(user: User, domainId: string) {
	return withDatabase((sql) => ownedDomain(sql, user, domainId));
}
export async function domainDnsDetails(
	user: User,
	domainId: string,
	client?: DomainCloudflare,
	lookup?: DnsLookup,
) {
	const domain = await getDomain(user, domainId),
		dns = await domainDns(
			client ??
				(domain.zone_id === "manual" ? null : await requireDomainClient()),
			domain,
			lookup,
		);
	return {
		domain: { ...domainDto(domain), sendingEnabled: dns.sendingEnabled },
		dns,
	};
}
export async function addDomain(
	user: User,
	value: unknown,
	client?: DomainCloudflare,
	lookup?: DnsLookup,
) {
	const input = addDomainSchema.parse(value),
		hostname = normalizeHostname(input.hostname);
	await withDatabase((sql) => domainActor(sql, user, true));
	const api = client ?? (await requireDomainClient()),
		preflight = await preflightDomain(user, hostname, api);
	return domainOperation(preflight.zone.id, async (assertOwned) => {
		await withDatabase(async (sql) => {
			await assertOwned(sql);
			await checkDomainClaim(sql, user, hostname, preflight.zone.id);
		});
		const receivingProvider = input.receivingProvider ?? "cloudflare",
			requestedSending =
				input.sendingProvider ??
				(input.enableSending === false ? "none" : "cloudflare"),
			provisioned = await provisionCloudflareDomain(api, hostname, {
				enableRouting:
					receivingProvider === "cloudflare" && (input.enableRouting ?? true),
				enableSending: requestedSending === "cloudflare",
				replaceMxRecords:
					receivingProvider === "cloudflare" ? input.replaceMxRecords : false,
				zone: preflight.zone,
			});
		let saved: DomainRecord;
		try {
			saved = await domainWrite(async (sql) => {
				await assertOwned(sql);
				const claimed = await checkDomainClaim(
						sql,
						user,
						hostname,
						preflight.zone.id,
					),
					previous = claimed
						? await ownedDomain(sql, user, claimed.id, true)
						: null,
					sendingProvider =
						input.sendingProvider ??
						(previous && previous.sending_provider !== "none"
							? previous.sending_provider
							: provisioned.sendingRequested
								? "cloudflare"
								: "none");
				const [row] =
					await sql.NativeSaveDomain`INSERT INTO domains(id,user_id,hostname,zone_id,status,routing_status,sending_subdomain_tag,sending_enabled,routing_enabled,sending_requested,sending_provider,receiving_provider,created_at) VALUES(${claimed?.id ?? id("dom")},${user.id},${hostname},${preflight.zone.id},${provisioned.routingEnabled || provisioned.sendingEnabled || receivingProvider !== "cloudflare" ? "active" : "pending"},${provisioned.routingStatus ?? null},${provisioned.sendingSubdomainTag},${provisioned.sendingEnabled ? 1 : 0},${provisioned.routingEnabled ? 1 : 0},${provisioned.sendingRequested ? 1 : 0},${sendingProvider},${receivingProvider},${seconds()}) ON CONFLICT(hostname) DO UPDATE SET zone_id=excluded.zone_id,status=excluded.status,routing_status=excluded.routing_status,sending_subdomain_tag=excluded.sending_subdomain_tag,sending_enabled=excluded.sending_enabled,routing_enabled=excluded.routing_enabled,sending_requested=excluded.sending_requested,sending_provider=excluded.sending_provider,receiving_provider=excluded.receiving_provider WHERE domains.user_id=excluded.user_id RETURNING *`;
				if (!row)
					throw new Response("Domain is already registered", { status: 409 });
				return domainRecord(row);
			});
		} catch (error) {
			const failures = await rollbackCloudflareDomain(api, provisioned.changes);
			if (failures.length)
				throw new AggregateError(
					[error, ...failures],
					"Domain setup failed and cleanup could not finish. Check Cloudflare routing before retrying.",
				);
			throw error;
		}
		let dns;
		try {
			dns = await domainDns(api, saved, lookup);
		} catch {
			dns = {
				routing: {
					records: [],
					missing: [],
					status: provisioned.routingStatus,
				},
				sending: [],
				sendingEnabled: provisioned.sendingEnabled,
			};
		}
		return { domain: domainDto(saved), dns, changes: provisioned.changes };
	});
}
export async function setupDomainDns(
	user: User,
	domainId: string,
	record: "mx" | "spf" | "dkim" | "dmarc",
	replaceMx = false,
	client?: DomainCloudflare,
	lookup?: DnsLookup,
) {
	const domain = await withDatabase((sql) =>
		ownedDomain(sql, user, domainId, true),
	);
	if (domain.zone_id === "manual")
		throw new Response("DNS for this domain is managed manually", {
			status: 400,
		});
	const api = client ?? (await requireDomainClient());
	return domainOperation(domain.zone_id, async (assertOwned) => {
		await setupDnsInOperation(
			user,
			domain,
			record,
			replaceMx,
			api,
			assertOwned,
		);
		return domainDnsDetails(user, domainId, api, lookup);
	});
}
async function setupDnsInOperation(
	user: User,
	domain: DomainRecord,
	record: "mx" | "spf" | "dkim" | "dmarc",
	replaceMx: boolean,
	api: DomainCloudflare,
	assertOwned: (sql: AppSQL) => Promise<void>,
) {
	await withDatabase(async (sql) => {
		await assertOwned(sql);
		await ownedDomain(sql, user, domain.id, true);
	});
	if (record === "mx" || record === "spf") {
		const zone = await api.zone(domain.zone_id),
			provisioned = await provisionCloudflareDomain(api, domain.hostname, {
				enableRouting: true,
				enableSending: false,
				replaceMxRecords: replaceMx,
				zone,
			});
		try {
			await domainWrite(async (sql) => {
				await assertOwned(sql);
				await ownedDomain(sql, user, domain.id, true);
				await sql.NativeSetDomainReceivingReady`UPDATE domains SET routing_enabled=${provisioned.routingEnabled ? 1 : 0},routing_status=COALESCE(${provisioned.routingStatus ?? null},routing_status),status=CASE WHEN ${provisioned.routingEnabled ? 1 : 0}=1 THEN 'active' ELSE status END WHERE id=${domain.id}`;
			});
		} catch (error) {
			const failures = await rollbackCloudflareDomain(api, provisioned.changes);
			if (failures.length)
				throw new AggregateError(
					[error, ...failures],
					"Domain setup failed and cleanup could not finish. Check Cloudflare routing before retrying.",
				);
			throw error;
		}
	} else if (record === "dkim") {
		const deleted: import("./cloudflare").DnsRecord[] = [];
		let created: SendingSubdomain | null = null;
		try {
			const result = await api.ensureSending(domain.zone_id, domain.hostname, {
				replaceMx,
				deletedMx: deleted,
			});
			created = result.created ? result.subdomain : null;
			await domainWrite(async (sql) => {
				await assertOwned(sql);
				await ownedDomain(sql, user, domain.id, true);
				await sql.NativeSetDomainSendingReady`UPDATE domains SET sending_subdomain_tag=${result.subdomain.tag},sending_enabled=${result.subdomain.enabled ? 1 : 0},sending_requested=1,status=CASE WHEN ${result.subdomain.enabled ? 1 : 0}=1 THEN 'active' ELSE status END WHERE id=${domain.id}`;
			});
		} catch (error) {
			const failures = await rollbackCloudflareDomain(api, {
				zoneId: domain.zone_id,
				enabledEmailRouting: false,
				createdSendingSubdomainTag: created?.tag ?? null,
				previousCatchAll: null,
				catchAllChanged: false,
				deletedMxRecords: deleted,
				migratedAddressRules: [],
			});
			if (failures.length)
				throw new AggregateError(
					[error, ...failures],
					"Domain setup failed and cleanup could not finish. Check Cloudflare routing before retrying.",
				);
			throw error;
		}
	} else {
		const name = "_dmarc." + domain.hostname,
			existing = await api.listDns(domain.zone_id, "TXT", name);
		if (!existing.some((row) => /v=dmarc1/i.test(row.content ?? "")))
			await api.createDns(domain.zone_id, {
				type: "TXT",
				name,
				content: "v=DMARC1; p=none",
				ttl: 3600,
			});
	}
}
export async function chooseDomainProvider(
	user: User,
	domainId: string,
	direction: "sending" | "receiving",
	provider: "none" | "cloudflare" | "resend" | "ses",
	replaceMx = false,
	client?: DomainCloudflare,
) {
	const domain = await withDatabase((sql) =>
		ownedDomain(sql, user, domainId, true),
	);
	return domainOperation(domain.zone_id, async (assertOwned) => {
		await domainWrite(async (sql) => {
			await assertOwned(sql);
			await ownedDomain(sql, user, domainId, true);
			if (direction === "sending")
				await sql.NativeChooseDomainSending`UPDATE domains SET sending_provider=${provider},sending_requested=CASE WHEN ${provider}='cloudflare' THEN 1 ELSE sending_requested END WHERE id=${domainId}`;
			else
				await sql.NativeChooseDomainReceiving`UPDATE domains SET receiving_provider=${provider} WHERE id=${domainId}`;
		});
		let warning: string | undefined;
		if (direction === "sending" && provider === "cloudflare") {
			try {
				await setupDnsInOperation(
					user,
					domain,
					"dkim",
					replaceMx,
					client ?? (await requireDomainClient()),
					assertOwned,
				);
			} catch (error) {
				if (error instanceof MxConflictError) throw error;
				warning =
					error instanceof Response
						? await error.text()
						: error instanceof Error
							? error.message
							: "Could not enable Cloudflare sending";
			}
		}
		return {
			domain: domainDto(await getDomain(user, domainId)),
			...(warning ? { warning } : {}),
		};
	});
}
export async function removeDomain(
	user: User,
	domainId: string,
	client?: DomainCloudflare,
) {
	const domain = await withDatabase((sql) =>
		ownedDomain(sql, user, domainId, true),
	);
	return domainOperation(domain.zone_id, async (assertOwned) => {
		const [sending] = await withDatabase(
			(sql) =>
				sql.NativeDomainSendingJob`SELECT j.id FROM outbound_jobs j JOIN messages m ON m.id=j.message_id JOIN mailboxes b ON b.id=m.mailbox_id WHERE b.domain_id=${domain.id} AND j.status='sending' LIMIT 1`,
		);
		if (sending)
			throw new Response("A message is being sent. Try again shortly.", {
				status: 409,
			});
		const siblings = await withDatabase(
			(sql) =>
				sql.NativeOtherDomainsOnZone`SELECT id FROM domains WHERE zone_id=${domain.zone_id} AND id<>${domain.id} LIMIT 1`,
		);
		const api = client ?? (await requireDomainClient().catch(() => null));
		if (api && domain.zone_id !== "manual") {
			const identities = await api.sending(domain.zone_id).catch(() => []),
				identity = identities.find(
					(row) => row.tag === domain.sending_subdomain_tag,
				);
			if (
				domain.sending_subdomain_tag &&
				identity &&
				!identity.name.startsWith("*.")
			)
				await api
					.deleteSending(domain.zone_id, domain.sending_subdomain_tag)
					.catch((error) =>
						console.warn(
							"Could not remove domain sending configuration",
							error,
						),
					);
			await removeCloudflareReceiving(api, domain, siblings.length > 0).catch(
				(error) =>
					console.warn("Could not remove domain routing configuration", error),
			);
		}
		await domainWrite(async (sql) => {
			await assertOwned(sql);
			await ownedDomain(sql, user, domain.id, true);
			await sql.NativeCancelDomainJobs`UPDATE outbound_jobs SET status='cancelled',updated_at=${seconds()} WHERE status='queued' AND message_id IN(SELECT m.id FROM messages m JOIN mailboxes b ON b.id=m.mailbox_id WHERE b.domain_id=${domain.id})`;
			await sql.NativeDeleteDomain`DELETE FROM domains WHERE id=${domain.id} AND user_id=${user.id}`;
		});
		return { ok: true };
	});
}

async function removeCloudflareReceiving(
	api: DomainCloudflare,
	domain: DomainRecord,
	hasOtherDomain: boolean,
) {
	const rules = await api.routingRules(domain.zone_id),
		targets = rules.filter(
			(rule) =>
				rule.matchers?.some(
					(matcher) =>
						matcher.type === "literal" &&
						matcher.field === "to" &&
						matcher.value?.split("@").at(-1)?.toLowerCase() ===
							domain.hostname.toLowerCase(),
				) &&
				rule.actions?.some(
					(action) =>
						action.type === "worker" &&
						action.value?.some(
							(worker) =>
								worker === "mailflare" || worker === api.access.workerName,
						),
				),
		);
	for (const rule of targets) {
		const key = rule.id ?? rule.tag;
		if (key) await api.deleteRoutingRule(domain.zone_id, key);
	}
	for (const record of await api.listDns(
		domain.zone_id,
		"MX",
		domain.hostname,
	)) {
		if (record.id && isCloudflareMx(record))
			await api.deleteDns(domain.zone_id, record.id);
	}
	if (!hasOtherDomain) {
		const external = rules.some(
				(rule) => !targets.includes(rule) && rule.enabled !== false,
			),
			catchAll = await api.catchAll(domain.zone_id),
			owned = catchAll?.actions?.some(
				(action) =>
					action.type === "worker" &&
					action.value?.some(
						(worker) =>
							worker === "mailflare" || worker === api.access.workerName,
					),
			);
		if (owned)
			await api.setCatchAll(domain.zone_id, {
				enabled: false,
				actions: [{ type: "drop" }],
				matchers: [{ type: "all" }],
			});
		if (!external && (!catchAll?.enabled || owned))
			await api.disableRouting(domain.zone_id);
	}
}
export async function removeCloudflareProvider(
	user: User,
	domainId: string,
	direction: "sending" | "receiving",
	client?: DomainCloudflare,
) {
	const domain = await withDatabase((sql) =>
		ownedDomain(sql, user, domainId, true),
	);
	if (
		(direction === "sending"
			? domain.sending_provider
			: domain.receiving_provider) === "cloudflare"
	)
		throw new Response("Switch to another provider before removing this one", {
			status: 400,
		});
	return domainOperation(domain.zone_id, async (assertOwned) => {
		await withDatabase(async (sql) => {
			await assertOwned(sql);
			await ownedDomain(sql, user, domainId, true);
		});
		const api = client ?? (await requireDomainClient());
		if (direction === "receiving") {
			const others = await withDatabase(
				(sql) =>
					sql.NativeCloudflareOtherReceivingDomains`SELECT id FROM domains WHERE zone_id=${domain.zone_id} AND id<>${domain.id} LIMIT 1`,
			);
			await removeCloudflareReceiving(api, domain, others.length > 0);
			await domainWrite(async (sql) => {
				await assertOwned(sql);
				await ownedDomain(sql, user, domainId, true);
				await sql.NativeClearDomainReceiving`UPDATE domains SET routing_enabled=0 WHERE id=${domain.id}`;
			});
		} else {
			const identity = findSendingSubdomain(
				domain.hostname,
				await api.sending(domain.zone_id),
			);
			if (identity?.name.startsWith("*."))
				throw new Response(
					"This wildcard sending identity covers other domains. Remove it in Cloudflare or use an exact sending identity before cleaning it up.",
					{ status: 409 },
				);
			if (identity) await api.deleteSending(domain.zone_id, identity.tag);
			await domainWrite(async (sql) => {
				await assertOwned(sql);
				await ownedDomain(sql, user, domainId, true);
				await sql.NativeClearDomainSending`UPDATE domains SET sending_subdomain_tag=NULL,sending_enabled=0,sending_requested=0 WHERE id=${domain.id}`;
			});
		}
		return { ok: true };
	});
}

export async function setupCloudflareReceiving(
	user: User,
	domainId: string,
	replaceMx = false,
	client?: DomainCloudflare,
) {
	const domain = await withDatabase((sql) =>
		ownedDomain(sql, user, domainId, true),
	);
	if (domain.zone_id === "manual")
		throw new Response("Cloudflare Email Routing needs a Cloudflare zone", {
			status: 400,
		});
	const api = client ?? (await requireDomainClient());
	return domainOperation(domain.zone_id, (assertOwned) =>
		setupDnsInOperation(user, domain, "mx", replaceMx, api, assertOwned),
	);
}
