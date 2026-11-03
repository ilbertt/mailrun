import {
	DomainCloudflare,
	MxConflictError,
	normalizeHostname,
	type DnsRecord,
	type CatchAll,
	type RoutingRule,
} from "./cloudflare";
export type DomainChanges = {
	zoneId: string;
	enabledEmailRouting: boolean;
	createdSendingSubdomainTag: string | null;
	previousCatchAll: CatchAll | null;
	catchAllChanged: boolean;
	deletedMxRecords: DnsRecord[];
	migratedAddressRules: { id: string; previous: RoutingRule }[];
};
export type ProvisionedDomain = {
	hostname: string;
	zone: { id: string; name: string };
	routingEnabled: boolean;
	routingStatus?: string;
	sendingEnabled: boolean;
	sendingRequested: boolean;
	sendingSubdomainTag: string | null;
	changes: DomainChanges;
};
export async function rollbackCloudflareDomain(
	client: DomainCloudflare,
	changes: DomainChanges,
) {
	const failures: unknown[] = [];
	const attempt = async (run: () => Promise<unknown>) => {
		try {
			await run();
		} catch (error) {
			failures.push(error);
		}
	};
	for (const rule of changes.migratedAddressRules)
		await attempt(() =>
			client.updateRoutingRule(changes.zoneId, rule.id, rule.previous),
		);
	if (changes.createdSendingSubdomainTag)
		await attempt(() =>
			client.deleteSending(changes.zoneId, changes.createdSendingSubdomainTag!),
		);
	if (changes.catchAllChanged)
		await attempt(() =>
			client.setCatchAll(
				changes.zoneId,
				changes.previousCatchAll ?? {
					enabled: false,
					actions: [{ type: "drop" }],
					matchers: [{ type: "all" }],
				},
			),
		);
	if (changes.enabledEmailRouting)
		await attempt(() => client.disableRouting(changes.zoneId));
	if (changes.deletedMxRecords.length)
		await attempt(() =>
			client.restoreMx(changes.zoneId, changes.deletedMxRecords),
		);
	return failures;
}
export async function provisionCloudflareDomain(
	client: DomainCloudflare,
	hostnameValue: string,
	options: {
		enableRouting?: boolean;
		enableSending?: boolean;
		replaceMxRecords?: boolean;
		zone?: { id: string; name: string };
	} = {},
): Promise<ProvisionedDomain> {
	const hostname = normalizeHostname(hostnameValue),
		zone = options.zone ?? (await client.findZone(hostname));
	if (!zone)
		throw new Error(
			`Zone not found for "${hostname}". The domain must use Cloudflare DNS on this account.`,
		);
	const changes: DomainChanges = {
		zoneId: zone.id,
		enabledEmailRouting: false,
		createdSendingSubdomainTag: null,
		previousCatchAll: null,
		catchAllChanged: false,
		deletedMxRecords: [],
		migratedAddressRules: [],
	};
	const enableRouting = options.enableRouting ?? true,
		enableSending = options.enableSending ?? true;
	let routingEnabled = false,
		routingStatus: string | undefined,
		sendingEnabled = false,
		sendingSubdomainTag: string | null = null;
	try {
		if (enableRouting) {
			if (!client.access.workerName)
				throw new Error("Complete email setup before enabling receiving");
			let wasEnabled: boolean | null = null;
			try {
				wasEnabled = (await client.routing(zone.id)).enabled ?? null;
			} catch {}
			changes.previousCatchAll = await client.catchAll(zone.id);
			if (
				changes.previousCatchAll &&
				(changes.previousCatchAll.enabled === undefined ||
					!changes.previousCatchAll.actions?.length ||
					!changes.previousCatchAll.matchers?.length)
			)
				throw new Error(
					"Could not read the current catch-all rule; routing was left unchanged",
				);
			if (
				changes.previousCatchAll?.source === "wrangler" &&
				!changes.previousCatchAll.owner_worker_tag
			)
				throw new Error(
					"The existing catch-all is managed by Wrangler. Move it to API management before changing receiving.",
				);
			const foreign = await client.foreignMx(zone.id, hostname);
			if (foreign.length && !options.replaceMxRecords) {
				throw new MxConflictError(
					foreign.map((record) => ({
						content: record.content ?? "",
						priority: record.priority ?? 0,
					})),
				);
			}
			if (options.replaceMxRecords)
				await client.removeForeignMx(
					zone.id,
					hostname,
					changes.deletedMxRecords,
				);
			const settings = await client.enableRouting(
				zone.id,
				hostname === zone.name ? undefined : hostname,
			);
			changes.enabledEmailRouting = wasEnabled === false;
			routingEnabled = settings.enabled ?? true;
			routingStatus = settings.status;
			changes.catchAllChanged = true;
			await client.bindRelay(zone.id);
			await client.migrateMailflareRules(
				zone.id,
				hostname,
				changes.migratedAddressRules,
			);
		}
		if (enableSending) {
			const result = await client.ensureSending(zone.id, hostname, {
				replaceMx: options.replaceMxRecords,
				deletedMx: changes.deletedMxRecords,
			});
			sendingEnabled = result.subdomain.enabled;
			sendingSubdomainTag = result.subdomain.tag;
			if (result.created)
				changes.createdSendingSubdomainTag = result.subdomain.tag;
		}
	} catch (error) {
		const failures = await rollbackCloudflareDomain(client, changes);
		if (failures.length)
			throw new AggregateError(
				[error, ...failures],
				"Domain setup failed and cleanup could not finish. Check Cloudflare routing before retrying.",
			);
		throw error;
	}
	return {
		hostname,
		zone: { id: zone.id, name: zone.name },
		routingEnabled,
		routingStatus,
		sendingEnabled,
		sendingRequested: enableSending,
		sendingSubdomainTag,
		changes,
	};
}
