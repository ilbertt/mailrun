import type { AppSQL } from "../db";
import type { DomainRecord } from "../domains/repository";
import { domainOperation } from "../domains/repository";
import type { DomainCloudflare } from "../domains/cloudflare";
import {
	providerDnsClient,
	normalizeDnsValue,
	hasProviderMx,
	publishProviderMx,
	removeProviderMx,
	isInboundSmtpMx,
} from "../domains/provider-dns";
import type { SesReceivingState } from "../../lib/aws/aws-types";
import type { SesSendingView } from "../../lib/aws/ses-sending-types";
import type {
	ReceivingStep,
	SesReceivingView,
} from "../../lib/aws/ses-receiving-types";
import { withDatabase } from "../db";
import { AwsClient, AwsError } from "./client";
import { SesClient } from "./ses";
import { S3Client, SnsClient, callerIdentity } from "./services";
import {
	SES_RECEIVING_REGIONS,
	getSesReceivingState,
	saveSesReceivingState,
} from "./settings";
export const SES_OBJECT_PREFIX = "inbound/";
export const sesInboundMx = (region: string) =>
	`inbound-smtp.${region}.amazonaws.com`;
export const sesRuleName = (hostname: string) =>
	`mailflare-${hostname.replace(/[^a-zA-Z0-9-_]/g, "-")}`
		.slice(0, 64)
		.replace(/-+$/, "");
async function missingDns(
	domain: DomainRecord,
	records: { name: string; value: string }[],
	api?: DomainCloudflare,
) {
	if (domain.zone_id === "manual") return null;
	try {
		const dns = await providerDnsClient(domain, api);
		if (!dns) return null;
		const present = await Promise.all(
			records.map(async (record) =>
				(await dns.listDns(domain.zone_id, "CNAME", record.name)).some(
					(row) =>
						normalizeDnsValue(row.content ?? "") ===
						normalizeDnsValue(record.value),
				),
			),
		);
		return present.filter((value) => !value).length;
	} catch {
		return null;
	}
}
export async function sesSendingView(
	domain: DomainRecord,
	client: AwsClient,
	api?: DomainCloudflare,
): Promise<SesSendingView> {
	const ses = new SesClient(client),
		[identity, account] = await Promise.all([
			ses.identity(domain.hostname),
			ses.account().catch(() => null),
		]);
	return {
		...identity,
		dnsManaged: domain.zone_id !== "manual",
		missingDns: identity.registered
			? await missingDns(domain, identity.records, api)
			: null,
		productionAccess: account?.productionAccess ?? null,
		region: client.config.region,
	};
}
export async function setupSesSending(
	domain: DomainRecord,
	client: AwsClient,
	api?: DomainCloudflare,
) {
	const identity = await new SesClient(client).createIdentity(domain.hostname),
		dns = await providerDnsClient(domain, api);
	if (dns)
		for (const record of identity.records) {
			const found = await dns.listDns(domain.zone_id, "CNAME", record.name);
			if (
				found.some(
					(row) =>
						normalizeDnsValue(row.content ?? "") ===
						normalizeDnsValue(record.value),
				)
			)
				continue;
			await dns.createDns(domain.zone_id, {
				type: "CNAME",
				name: record.name,
				content: record.value,
				ttl: 3600,
				proxied: false,
			});
		}
	return sesSendingView(domain, client, api);
}
export async function removeSesSending(
	domain: DomainRecord,
	client: AwsClient,
	api?: DomainCloudflare,
) {
	// SES uses the same verified identity for receiving. Removing an unused sender
	// must not revoke a domain that is still receiving through this account.
	if (domain.receiving_provider === "ses")
		throw new Response(
			"This SES identity is still used for receiving. Switch receiving providers before removing it.",
			{ status: 400 },
		);
	const ses = new SesClient(client),
		identity = await ses.identity(domain.hostname),
		dns = await providerDnsClient(domain, api);
	if (dns)
		for (const record of identity.records)
			for (const row of await dns.listDns(domain.zone_id, "CNAME", record.name))
				if (
					row.id &&
					normalizeDnsValue(row.content ?? "") ===
						normalizeDnsValue(record.value)
				)
					await dns.deleteDns(domain.zone_id, row.id);
	await ses.deleteIdentity(domain.hostname);
}
export async function setupSesReceiving(
	domain: DomainRecord,
	client: AwsClient,
	origin: string,
	replaceMx: boolean,
	api?: DomainCloudflare,
	assertActor?: (sql: AppSQL) => Promise<void>,
) {
	if (!SES_RECEIVING_REGIONS.includes(client.config.region))
		throw new Error(
			`Amazon SES cannot receive mail in ${client.config.region}. Use a region such as us-east-1, us-west-2 or eu-west-1.`,
		);
	const url = new URL(origin);
	if (
		url.protocol !== "https:" ||
		/^(localhost|127\.|\[::1\]|.*\.localhost$|.*\.test$)/.test(url.hostname)
	)
		throw new Error(
			"SES delivers mail by calling this app over public HTTPS. Set APP_URL to your public address (localhost will not work).",
		);
	return domainOperation("ses-receiving", async (assertOwned) => {
		const guard = async (sql: AppSQL) => {
			await assertOwned(sql);
			await assertActor?.(sql);
		};
		const check = () => withDatabase(guard);
		await check();
		const who = await callerIdentity(client),
			previous = await getSesReceivingState(),
			partition = who.arn.split(":")[1] ?? "aws";
		const sameAccount =
			previous?.accountId === who.accountId &&
			previous.region === client.config.region;
		const suffix = new Bun.CryptoHasher("sha256")
			.update(origin)
			.digest("hex")
			.slice(0, 12);
		const state: SesReceivingState = {
			region: client.config.region,
			accountId: who.accountId,
			bucket: sameAccount
				? previous.bucket
				: `mailflare-inbound-${who.accountId}-${client.config.region}-${suffix}`,
			topicArn: "",
			ruleSet: previous?.ruleSet ?? "mailflare-inbound",
			token: sameAccount
				? previous.token
				: crypto.randomUUID().replace(/-/g, ""),
			endpoint: "",
		};
		state.endpoint =
			origin.replace(/\/$/, "") + "/api/inbound/ses?token=" + state.token;
		// A verified SES identity is required for inbound as well as outbound mail.
		// Full-access keys provision it here; restricted operators can verify it in
		// SES themselves, as they could in the original application.
		try {
			await setupSesSending(domain, client, api);
		} catch (error) {
			if (!(error instanceof AwsError && error.accessDenied)) throw error;
		}
		const s3 = new S3Client(client),
			sns = new SnsClient(client),
			ses = new SesClient(client);
		await check();
		await s3.create(state.bucket);
		await s3.policy(state.bucket, {
			Version: "2012-10-17",
			Statement: [
				{
					Sid: "AllowSESPuts",
					Effect: "Allow",
					Principal: { Service: "ses.amazonaws.com" },
					Action: "s3:PutObject",
					Resource: `arn:${partition}:s3:::${state.bucket}/*`,
					Condition: { StringEquals: { "aws:Referer": who.accountId } },
				},
			],
		});
		await s3
			.lifecycle(state.bucket, SES_OBJECT_PREFIX, 1)
			.catch(() => undefined);
		await check();
		state.topicArn = sameAccount
			? previous.topicArn
			: await sns.createTopic("mailflare-inbound-" + suffix);
		await sns.policy(state.topicArn, {
			Version: "2008-10-17",
			Statement: [
				{
					Sid: "AllowOwner",
					Effect: "Allow",
					Principal: { AWS: "*" },
					Action: [
						"SNS:GetTopicAttributes",
						"SNS:SetTopicAttributes",
						"SNS:AddPermission",
						"SNS:RemovePermission",
						"SNS:DeleteTopic",
						"SNS:Subscribe",
						"SNS:ListSubscriptionsByTopic",
						"SNS:Publish",
					],
					Resource: state.topicArn,
					Condition: { StringEquals: { "AWS:SourceOwner": who.accountId } },
				},
				{
					Sid: "AllowSESPublish",
					Effect: "Allow",
					Principal: { Service: "ses.amazonaws.com" },
					Action: "SNS:Publish",
					Resource: state.topicArn,
					Condition: { StringEquals: { "AWS:SourceAccount": who.accountId } },
				},
			],
		});
		// Persist the token before Subscribe: SNS may deliver its confirmation while
		// the setup request is still waiting for the subscription API response.
		await saveSesReceivingState(client.config, state, guard);
		const subscriptions = await sns.subscriptions(state.topicArn);
		if (!subscriptions.some((row) => row.endpoint === state.endpoint))
			await sns.subscribe(state.topicArn, state.endpoint);
		const active = await ses.activeRuleSet();
		if (active.name) state.ruleSet = active.name;
		else {
			await ses.createRuleSet(state.ruleSet);
			await ses.activateRuleSet(state.ruleSet);
		}
		await check();
		await ses.upsertRule({
			ruleSet: state.ruleSet,
			name: sesRuleName(domain.hostname),
			recipient: domain.hostname,
			bucket: state.bucket,
			prefix: SES_OBJECT_PREFIX,
			topicArn: state.topicArn,
		});
		await saveSesReceivingState(client.config, state, guard);
		await publishProviderMx(
			domain,
			sesInboundMx(client.config.region),
			replaceMx,
			api,
		);
	});
}
export async function sesReceivingView(
	domain: DomainRecord,
	client: AwsClient,
	api?: DomainCloudflare,
): Promise<SesReceivingView> {
	const state = await getSesReceivingState(),
		region = client.config.region,
		mx = sesInboundMx(region),
		ses = new SesClient(client),
		steps: ReceivingStep[] = [],
		regionOk = SES_RECEIVING_REGIONS.includes(region);
	steps.push({
		key: "region",
		label: "Region supports receiving",
		ok: regionOk,
		detail: regionOk ? region : `${region} cannot receive mail`,
	});
	const attempt = async (run: () => Promise<boolean>) => {
		try {
			return await run();
		} catch (error) {
			if (error instanceof AwsError) return false;
			throw error;
		}
	};
	const bucketOk =
		!!state &&
		state.region === region &&
		(await attempt(() => new S3Client(client).exists(state.bucket)));
	steps.push({
		key: "bucket",
		label: "S3 bucket for raw mail",
		ok: bucketOk,
		detail: state?.bucket,
	});
	const subscribed =
		!!state &&
		state.region === region &&
		(await attempt(async () =>
			(
				await new SnsClient(client).subscriptions(state.topicArn)
			).some((row) => row.endpoint === state.endpoint && row.confirmed),
		));
	steps.push({
		key: "topic",
		label: "SNS topic delivering to Mailflare",
		ok: subscribed,
		detail: state && !subscribed ? "Subscription not confirmed yet" : undefined,
	});
	const ruleOk =
		!!state &&
		state.region === region &&
		(await attempt(() =>
			ses.hasRule(state.ruleSet, sesRuleName(domain.hostname)),
		));
	const identity = await ses.identity(domain.hostname).catch((error) => {
		if (error instanceof AwsError && error.accessDenied) return null;
		throw error;
	});
	steps.push({
		key: "rule",
		label: "SES receipt rule for this domain",
		ok: ruleOk,
		detail: ruleOk
			? identity === null
				? "Domain verification could not be checked; grant ses:GetEmailIdentity"
				: identity.verified === false
					? "Verify this domain in SES before receiving mail"
					: state?.ruleSet
			: undefined,
	});
	const mxOk = await hasProviderMx(domain, mx, api);
	steps.push({
		key: "mx",
		label: "MX record points to SES",
		ok: mxOk === true,
		detail: mxOk === null ? "Add the MX record in your DNS" : mx,
	});
	return {
		steps,
		ready: steps.every((row) => row.ok) && identity?.verified === true,
		region,
		mx,
		dnsManaged: domain.zone_id !== "manual",
	};
}
export async function hasSesReceiving(domain: DomainRecord, client: AwsClient) {
	try {
		const state = await getSesReceivingState();
		return (
			!!state &&
			state.region === client.config.region &&
			(await new SesClient(client).hasRule(
				state.ruleSet,
				sesRuleName(domain.hostname),
			))
		);
	} catch {
		return null;
	}
}
export async function removeSesReceiving(
	domain: DomainRecord,
	client: AwsClient,
	api?: DomainCloudflare,
) {
	const state = await getSesReceivingState();
	if (state)
		await new SesClient(client).deleteRule(
			state.ruleSet,
			sesRuleName(domain.hostname),
		);
	if (domain.receiving_provider !== "resend")
		await removeProviderMx(domain, isInboundSmtpMx, api);
}
