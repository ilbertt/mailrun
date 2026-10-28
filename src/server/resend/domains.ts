import { withDatabase } from "../db";
import {
	DomainCloudflare,
	cloudflareAccess,
	MxConflictError,
} from "../domains/cloudflare";
import { domainOperation, type DomainRecord } from "../domains/repository";
import type { ResendDomainView } from "../../lib/domains/resend-domain-types";
import type { ResendReceivingView } from "../../lib/domains/resend-receiving-types";
import type { ReceivingStep } from "../../lib/aws/ses-receiving-types";
import {
	ResendClient,
	ResendRestrictedKeyError,
	type ResendDomain,
	type ResendRecord,
} from "./client";
import {
	requireResendKey,
	resendKeyStatus,
	resendWebhookSecret,
	storeResendWebhook,
} from "./settings";

export const isInboundSmtpMx = (value: string) =>
	/inbound-smtp\.[a-z0-9-]+\.amazonaws\.com\.?$/i.test(value.trim());
const normalize = (value: string) =>
	value.replace(/^"|"$/g, "").trim().toLowerCase().replace(/\.$/, "");
const managed = (domain: DomainRecord) => domain.zone_id !== "manual";
function absoluteName(record: ResendRecord, hostname: string) {
	const name = record.name.trim();
	return !name || name === "@"
		? hostname
		: name === hostname || name.endsWith("." + hostname)
			? name
			: name + "." + hostname;
}
const sendingRecords = (domain: ResendDomain | null) =>
	(domain?.records ?? []).filter(
		(row) => !(row.type === "MX" && isInboundSmtpMx(row.value)),
	);
async function dnsClient(domain: DomainRecord, client?: DomainCloudflare) {
	if (!managed(domain)) return null;
	if (client) return client;
	const credentials = await cloudflareAccess();
	if (!credentials)
		throw new Error(
			"Configure Cloudflare email during setup before managing DNS",
		);
	return new DomainCloudflare(credentials);
}
async function recordExists(
	api: DomainCloudflare,
	domain: DomainRecord,
	record: ResendRecord,
) {
	return (
		await api.listDns(
			domain.zone_id,
			record.type,
			absoluteName(record, domain.hostname),
		)
	).some((row) => normalize(row.content ?? "") === normalize(record.value));
}
async function view(
	domain: DomainRecord,
	resend: ResendDomain | null,
	api?: DomainCloudflare,
): Promise<ResendDomainView> {
	let missingDns: number | null = null;
	if (resend && managed(domain))
		try {
			const dns = await dnsClient(domain, api);
			if (dns) {
				const present = await Promise.all(
					sendingRecords(resend).map((record) =>
						recordExists(dns, domain, record),
					),
				);
				missingDns = present.filter((value) => !value).length;
			}
		} catch {}
	return {
		registered: !!resend,
		status: resend?.status ?? "not_registered",
		dnsManaged: managed(domain),
		missingDns,
		records: sendingRecords(resend).map((row) => ({
			record: row.record,
			type: row.type,
			name: row.name,
			value: row.value,
			priority: row.priority ?? null,
			status: row.status ?? "unknown",
		})),
	};
}
export async function getResendSending(
	domain: DomainRecord,
	resend: ResendClient,
	api?: DomainCloudflare,
) {
	return view(domain, await resend.findDomain(domain.hostname), api);
}
export async function resendSendingStatus(
	domain: DomainRecord,
	resend?: ResendClient,
) {
	try {
		let client = resend;
		if (!client) {
			const { apiKey } = await resendKeyStatus();
			if (!apiKey) return null;
			client = new ResendClient(apiKey);
		}
		const result = await client.findDomain(domain.hostname);
		return !result || result.capabilities?.sending === "disabled"
			? "not_registered"
			: result.status;
	} catch {
		return null;
	}
}
export async function setupResendSending(
	domain: DomainRecord,
	resend: ResendClient,
	api?: DomainCloudflare,
) {
	let current = await resend.findDomain(domain.hostname);
	if (!current) {
		const created = await resend.createDomain(domain.hostname, {
			sending: true,
			receiving: domain.receiving_provider === "resend",
		});
		current = await resend.getDomain(created.id);
	} else if (current.capabilities?.sending === "disabled") {
		await resend.capabilities(current.id, { sending: true });
		current = await resend.getDomain(current.id);
	}
	const dns = await dnsClient(domain, api);
	if (dns)
		for (const record of sendingRecords(current))
			if (!(await recordExists(dns, domain, record)))
				await dns.createDns(domain.zone_id, {
					type: record.type,
					name: absoluteName(record, domain.hostname),
					content: record.value,
					ttl: 3600,
					...(record.type === "MX" ? { priority: record.priority ?? 10 } : {}),
					...(record.type === "CNAME" ? { proxied: false } : {}),
				});
	await resend.verifyDomain(current.id);
	return view(domain, await resend.getDomain(current.id), api);
}
export async function verifyResendSending(
	domain: DomainRecord,
	resend: ResendClient,
	api?: DomainCloudflare,
) {
	const current = await resend.findDomain(domain.hostname);
	if (!current) return view(domain, null, api);
	await resend.verifyDomain(current.id);
	return view(domain, await resend.getDomain(current.id), api);
}
async function deleteRecords(
	domain: DomainRecord,
	records: ResendRecord[],
	api?: DomainCloudflare,
) {
	const dns = await dnsClient(domain, api);
	if (!dns) return;
	for (const record of records)
		for (const item of await dns.listDns(
			domain.zone_id,
			record.type,
			absoluteName(record, domain.hostname),
		))
			if (item.id && normalize(item.content ?? "") === normalize(record.value))
				await dns.deleteDns(domain.zone_id, item.id);
}
export async function removeResendSending(
	domain: DomainRecord,
	resend: ResendClient,
	api?: DomainCloudflare,
) {
	const current = await resend.findDomain(domain.hostname);
	if (!current) return;
	await deleteRecords(
		domain,
		domain.receiving_provider === "resend"
			? sendingRecords(current)
			: (current.records ?? []),
		api,
	);
	if (domain.receiving_provider === "resend")
		await resend.capabilities(current.id, { sending: false });
	else await resend.deleteDomain(current.id);
}
const webhookUrl = (origin: string) =>
	origin.replace(/\/$/, "") + "/api/inbound/resend";
async function ensureWebhook(resend: ResendClient, origin: string) {
	// Every domain shares this registration and its once-issued signing secret.
	await domainOperation("resend-webhook", async (assertOwned) => {
		const endpoint = webhookUrl(origin),
			existing = (await resend.webhooks()).find(
				(row) => row.endpoint === endpoint,
			);
		const saved = await resendWebhookSecret();
		if (
			existing &&
			saved?.resend_webhook_id === existing.id &&
			saved.resend_webhook_secret
		)
			return;
		await withDatabase((sql) => assertOwned(sql));
		if (existing) await resend.deleteWebhook(existing.id);
		await withDatabase((sql) => assertOwned(sql));
		const created = await resend.createWebhook(endpoint);
		try {
			await storeResendWebhook(
				resend.apiKey,
				created.id,
				created.signing_secret,
				assertOwned,
			);
		} catch (error) {
			await resend.deleteWebhook(created.id).catch(() => undefined);
			throw error;
		}
	});
}
export async function setupResendReceiving(
	domain: DomainRecord,
	resend: ResendClient,
	origin: string,
	replaceMx: boolean,
	api?: DomainCloudflare,
) {
	const url = new URL(origin);
	if (
		url.protocol !== "https:" ||
		/^(localhost|127\.|\[::1\]|.*\.localhost$|.*\.test$)/.test(url.hostname)
	)
		throw new Error(
			"Resend delivers mail by calling this app over public HTTPS. Set APP_URL to your public address (localhost will not work).",
		);
	let current = await resend.findDomain(domain.hostname);
	if (!current) {
		const created = await resend.createDomain(domain.hostname, {
			sending: domain.sending_provider === "resend",
			receiving: true,
		});
		current = await resend.getDomain(created.id);
	} else if (current.capabilities?.receiving !== "enabled") {
		await resend.capabilities(current.id, { receiving: true });
		current = await resend.getDomain(current.id);
	}
	const mx = (current.records ?? []).find(
		(row) => row.type === "MX" && isInboundSmtpMx(row.value),
	);
	if (!mx)
		throw new Error(
			"Resend did not return a receiving MX record for this domain.",
		);
	const dns = await dnsClient(domain, api);
	if (dns) {
		const records = await dns.listDns(domain.zone_id, "MX", domain.hostname),
			others = records.filter(
				(row) => normalize(row.content ?? "") !== normalize(mx.value),
			);
		if (others.length && !replaceMx)
			throw new MxConflictError(
				others.map((row) => ({
					content: row.content ?? "",
					priority: row.priority ?? 0,
				})),
			);
		for (const row of others)
			if (row.id) await dns.deleteDns(domain.zone_id, row.id);
		if (
			!records.some(
				(row) => normalize(row.content ?? "") === normalize(mx.value),
			)
		)
			await dns.createDns(domain.zone_id, {
				type: "MX",
				name: domain.hostname,
				content: mx.value,
				priority: mx.priority ?? 10,
				ttl: 3600,
			});
	}
	await ensureWebhook(resend, origin);
	await resend.verifyDomain(current.id).catch(() => undefined);
}
export async function getResendReceiving(
	domain: DomainRecord,
	origin: string,
	resend?: ResendClient,
	api?: DomainCloudflare,
): Promise<ResendReceivingView> {
	const credentials = await resendKeyStatus();
	const steps: ReceivingStep[] = [
		{
			key: "key",
			label: "Resend API key",
			ok: credentials.configured,
			detail: credentials.configured
				? undefined
				: "Add a key under Sending or here",
		},
	];
	const base = {
		dnsManaged: managed(domain),
		steps,
		ready: false,
		mx: null,
		restrictedKey: false,
	};
	if (!credentials.apiKey) return base;
	const client = resend ?? new ResendClient(credentials.apiKey);
	try {
		const current = await client.findDomain(domain.hostname),
			enabled = current?.capabilities?.receiving === "enabled";
		steps.push({
			key: "domain",
			label: "Receiving enabled for this domain",
			ok: enabled,
			detail: !current ? "Domain is not in Resend yet" : undefined,
		});
		const mx = current?.records?.find(
				(row) => row.type === "MX" && isInboundSmtpMx(row.value),
			),
			dns = await dnsClient(domain, api);
		const mxOk =
			mx && dns
				? (await dns.listDns(domain.zone_id, "MX", domain.hostname)).some(
						(row) => normalize(row.content ?? "") === normalize(mx.value),
					)
				: false;
		steps.push({
			key: "mx",
			label: "MX record points to Resend",
			ok: !!mxOk,
			detail: mx?.value,
		});
		steps.push({
			key: "verified",
			label: "Domain verified",
			ok: current?.status === "verified",
			detail: current?.status.replace(/_/g, " "),
		});
		const hooks = await client.webhooks();
		steps.push({
			key: "webhook",
			label: "Webhook delivering mail to Mailflare",
			ok:
				hooks.some((row) => row.endpoint === webhookUrl(origin)) &&
				!!(await resendWebhookSecret())?.resend_webhook_secret,
		});
		return {
			...base,
			ready: steps.every((step) => step.ok),
			mx: mx?.value ?? null,
		};
	} catch (error) {
		if (error instanceof ResendRestrictedKeyError)
			return { ...base, restrictedKey: true };
		throw error;
	}
}
export async function resendReceivingPresence(
	domain: DomainRecord,
	resend?: ResendClient,
) {
	try {
		const client = resend ?? new ResendClient(await requireResendKey());
		return (
			(await client.findDomain(domain.hostname))?.capabilities?.receiving ===
			"enabled"
		);
	} catch {
		return null;
	}
}
export async function removeResendReceiving(
	domain: DomainRecord,
	resend: ResendClient,
	api?: DomainCloudflare,
) {
	const current = await resend.findDomain(domain.hostname),
		dns = await dnsClient(domain, api);
	if (dns && domain.receiving_provider !== "ses")
		for (const row of await dns.listDns(domain.zone_id, "MX", domain.hostname))
			if (row.id && isInboundSmtpMx(row.content ?? ""))
				await dns.deleteDns(domain.zone_id, row.id);
	if (!current) return;
	if (domain.sending_provider === "resend")
		await resend.capabilities(current.id, { receiving: false });
	else await resend.deleteDomain(current.id);
}
