import { z } from "zod";
import type { SesIdentityStatus } from "../../lib/aws/aws-types";
import { AwsClient, AwsError, awsSuffix } from "./client";
import { xmlBlocks, xmlTag } from "./xml";
const identity = z.object({
	VerifiedForSendingStatus: z.boolean().optional(),
	DkimAttributes: z
		.object({
			Status: z.string().optional(),
			Tokens: z.array(z.string()).optional(),
		})
		.optional(),
});
function identityStatus(
	hostname: string,
	value: z.infer<typeof identity> | null,
): SesIdentityStatus {
	return value
		? {
				registered: true,
				verified: !!value.VerifiedForSendingStatus,
				dkimStatus: value.DkimAttributes?.Status ?? "NOT_STARTED",
				records: (value.DkimAttributes?.Tokens ?? []).map((token) => ({
					type: "CNAME",
					name: `${token}._domainkey.${hostname}`,
					value: `${token}.dkim.amazonses.com`,
				})),
			}
		: {
				registered: false,
				verified: false,
				dkimStatus: "NOT_REGISTERED",
				records: [],
			};
}
export class SesClient {
	constructor(readonly aws: AwsClient) {}
	endpoint(path: string) {
		return {
			service: "ses",
			host: `email.${this.aws.config.region}.${awsSuffix(this.aws.config.region)}`,
			path,
		};
	}
	async account() {
		const value = await this.aws.json(
			z.object({
				ProductionAccessEnabled: z.boolean().optional(),
				SendingEnabled: z.boolean().optional(),
			}),
			this.endpoint("/v2/email/account"),
		);
		return {
			productionAccess: !!value.ProductionAccessEnabled,
			sendingEnabled: value.SendingEnabled !== false,
		};
	}
	async identity(hostname: string) {
		try {
			return identityStatus(
				hostname,
				await this.aws.json(
					identity,
					this.endpoint("/v2/email/identities/" + encodeURIComponent(hostname)),
				),
			);
		} catch (error) {
			if (
				error instanceof AwsError &&
				(error.status === 404 || error.code === "NotFoundException")
			)
				return identityStatus(hostname, null);
			throw error;
		}
	}
	async createIdentity(hostname: string) {
		try {
			return identityStatus(
				hostname,
				await this.aws.json(identity, {
					...this.endpoint("/v2/email/identities"),
					method: "POST",
					json: {
						EmailIdentity: hostname,
						DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" },
					},
				}),
			);
		} catch (error) {
			if (error instanceof AwsError && error.code === "AlreadyExistsException")
				return this.identity(hostname);
			throw error;
		}
	}
	async deleteIdentity(hostname: string) {
		try {
			await this.aws.json(z.unknown(), {
				...this.endpoint(
					"/v2/email/identities/" + encodeURIComponent(hostname),
				),
				method: "DELETE",
			});
		} catch (error) {
			if (!(error instanceof AwsError && error.status === 404)) throw error;
		}
	}
	query(action: string, params: Record<string, string> = {}) {
		return this.aws.query("email", "2010-12-01", action, params, {
			host: `email.${this.aws.config.region}.${awsSuffix(this.aws.config.region)}`,
			signingService: "ses",
		});
	}
	async activeRuleSet() {
		const xml = await this.query("DescribeActiveReceiptRuleSet"),
			metadata = xmlBlocks(xml, "Metadata")[0] ?? "",
			rules = xmlBlocks(xml, "Rules")[0] ?? "";
		return {
			name: xmlTag(metadata, "Name"),
			rules: xmlBlocks(rules, "member")
				.map((member) => xmlTag(member, "Name") ?? "")
				.filter(Boolean),
		};
	}
	async createRuleSet(name: string) {
		try {
			await this.query("CreateReceiptRuleSet", { RuleSetName: name });
		} catch (error) {
			if (!(error instanceof AwsError && error.code === "AlreadyExists"))
				throw error;
		}
	}
	async activateRuleSet(name: string) {
		await this.query("SetActiveReceiptRuleSet", { RuleSetName: name });
	}
	async upsertRule(input: {
		ruleSet: string;
		name: string;
		recipient: string;
		bucket: string;
		prefix: string;
		topicArn: string;
	}) {
		const params = {
			RuleSetName: input.ruleSet,
			"Rule.Name": input.name,
			"Rule.Enabled": "true",
			"Rule.ScanEnabled": "true",
			"Rule.TlsPolicy": "Optional",
			"Rule.Recipients.member.1": input.recipient,
			"Rule.Actions.member.1.S3Action.BucketName": input.bucket,
			"Rule.Actions.member.1.S3Action.ObjectKeyPrefix": input.prefix,
			"Rule.Actions.member.1.S3Action.TopicArn": input.topicArn,
		};
		try {
			await this.query("CreateReceiptRule", params);
		} catch (error) {
			if (error instanceof AwsError && error.code === "AlreadyExists")
				await this.query("UpdateReceiptRule", params);
			else throw error;
		}
	}
	async hasRule(ruleSet: string, name: string) {
		try {
			await this.query("DescribeReceiptRule", {
				RuleSetName: ruleSet,
				RuleName: name,
			});
			return true;
		} catch (error) {
			if (error instanceof AwsError && /DoesNotExist/.test(error.code))
				return false;
			throw error;
		}
	}
	async deleteRule(ruleSet: string, name: string) {
		try {
			await this.query("DeleteReceiptRule", {
				RuleSetName: ruleSet,
				RuleName: name,
			});
		} catch (error) {
			if (!(error instanceof AwsError && /DoesNotExist/.test(error.code)))
				throw error;
		}
	}
}
