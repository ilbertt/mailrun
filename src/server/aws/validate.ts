import type { AwsCapabilityReport } from "../../lib/aws/aws-types";
import { AwsClient, AwsError } from "./client";
import { isValidRegion, SES_RECEIVING_REGIONS } from "./settings";
import { SesClient } from "./ses";
import { SnsClient, S3Client, callerIdentity } from "./services";
export class AwsCredentialsError extends Error {}
async function probe(run: () => Promise<unknown>) {
	try {
		await run();
		return true;
	} catch (error) {
		if (error instanceof AwsError && error.accessDenied) return false;
		throw error;
	}
}
export async function validateAwsConfig(
	client: AwsClient,
): Promise<AwsCapabilityReport> {
	const config = client.config;
	if (!isValidRegion(config.region))
		throw new AwsCredentialsError(
			`"${config.region}" is not a valid AWS region`,
		);
	let who: { accountId: string; arn: string };
	try {
		who = await callerIdentity(client);
	} catch (error) {
		if (error instanceof AwsError) {
			if (
				/InvalidClientTokenId|SignatureDoesNotMatch|IncompleteSignature|UnrecognizedClient|InvalidAccessKeyId/i.test(
					error.code,
				)
			)
				throw new AwsCredentialsError(
					"AWS rejected these credentials. Check the access key ID and secret.",
				);
			if (/ExpiredToken/i.test(error.code))
				throw new AwsCredentialsError("These AWS credentials have expired.");
			throw new AwsCredentialsError("AWS: " + error.message);
		}
		throw error;
	}
	const ses = new SesClient(client);
	let productionAccess: boolean | null = null;
	const [sending, receiving, sns, s3] = await Promise.all([
		probe(async () => {
			productionAccess = (await ses.account()).productionAccess;
		}),
		probe(() => ses.activeRuleSet()),
		probe(() => new SnsClient(client).listTopics()),
		probe(() => new S3Client(client).listBuckets()),
	]);
	const missing: string[] = [];
	if (!sending)
		missing.push(
			"ses:GetAccount",
			"ses:SendEmail",
			"ses:CreateEmailIdentity",
			"ses:GetEmailIdentity",
		);
	if (!receiving)
		missing.push(
			"ses:DescribeActiveReceiptRuleSet",
			"ses:CreateReceiptRule",
			"ses:SetActiveReceiptRuleSet",
		);
	if (!sns)
		missing.push("sns:CreateTopic", "sns:Subscribe", "sns:SetTopicAttributes");
	if (!s3)
		missing.push(
			"s3:CreateBucket",
			"s3:PutBucketPolicy",
			"s3:GetObject",
			"s3:DeleteObject",
		);
	return {
		...who,
		region: config.region,
		sending,
		productionAccess,
		receivingRegion: SES_RECEIVING_REGIONS.includes(config.region),
		receiving,
		sns,
		s3,
		missing,
	};
}
/** The IAM policy that grants everything Mailflare does, for the admin to attach. */
export const AWS_IAM_POLICY = {
	Version: "2012-10-17",
	Statement: [
		{
			Effect: "Allow",
			Action: [
				"sts:GetCallerIdentity",
				"ses:GetAccount",
				"ses:SendEmail",
				"ses:CreateEmailIdentity",
				"ses:GetEmailIdentity",
				"ses:DeleteEmailIdentity",
			],
			Resource: "*",
		},
		{
			Effect: "Allow",
			Action: [
				"ses:DescribeActiveReceiptRuleSet",
				"ses:CreateReceiptRuleSet",
				"ses:SetActiveReceiptRuleSet",
				"ses:CreateReceiptRule",
				"ses:UpdateReceiptRule",
				"ses:DescribeReceiptRule",
				"ses:DeleteReceiptRule",
			],
			Resource: "*",
		},
		{
			Effect: "Allow",
			Action: [
				"sns:ListTopics",
				"sns:CreateTopic",
				"sns:SetTopicAttributes",
				"sns:Subscribe",
				"sns:ListSubscriptionsByTopic",
			],
			Resource: "*",
		},
		{
			Effect: "Allow",
			Action: [
				"s3:ListAllMyBuckets",
				"s3:CreateBucket",
				"s3:PutBucketPolicy",
				"s3:PutLifecycleConfiguration",
				"s3:ListBucket",
				"s3:GetObject",
				"s3:DeleteObject",
			],
			Resource: "*",
		},
	],
};
