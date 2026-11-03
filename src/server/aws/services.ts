import { z } from "zod";
import { AwsClient, AwsError, awsSuffix } from "./client";
import { xmlTag, xmlBlocks } from "./xml";
export async function callerIdentity(client: AwsClient) {
	const xml = await client.query("sts", "2011-06-15", "GetCallerIdentity");
	return z
		.object({
			accountId: z.string().regex(/^\d{12}$/),
			arn: z.string().regex(/^arn:aws(?:-us-gov|-cn)?:/),
		})
		.parse({ accountId: xmlTag(xml, "Account"), arn: xmlTag(xml, "Arn") });
}
export class SnsClient {
	constructor(readonly aws: AwsClient) {}
	query(action: string, params: Record<string, string> = {}) {
		return this.aws.query("sns", "2010-03-31", action, params);
	}
	async listTopics() {
		await this.query("ListTopics");
	}
	async createTopic(name: string) {
		const xml = await this.query("CreateTopic", { Name: name }),
			arn = xmlTag(xml, "TopicArn");
		if (!arn) throw new Error("SNS did not return a topic ARN");
		return arn;
	}
	async policy(topicArn: string, policy: unknown) {
		await this.query("SetTopicAttributes", {
			TopicArn: topicArn,
			AttributeName: "Policy",
			AttributeValue: JSON.stringify(policy),
		});
	}
	async subscribe(topicArn: string, endpoint: string) {
		await this.query("Subscribe", {
			TopicArn: topicArn,
			Protocol: "https",
			Endpoint: endpoint,
			ReturnSubscriptionArn: "true",
		});
	}
	async subscriptions(topicArn: string) {
		const xml = await this.query("ListSubscriptionsByTopic", {
			TopicArn: topicArn,
		});
		return xmlBlocks(xml, "member").map((member) => ({
			endpoint: xmlTag(member, "Endpoint") ?? "",
			confirmed:
				!!xmlTag(member, "SubscriptionArn") &&
				xmlTag(member, "SubscriptionArn") !== "PendingConfirmation",
		}));
	}
}
const escapeXml = (value: string) =>
	value.replace(
		/[<>&"']/g,
		(char) =>
			({
				"<": "&lt;",
				">": "&gt;",
				"&": "&amp;",
				'"': "&quot;",
				"'": "&apos;",
			})[char] ?? char,
	);
export class S3Client {
	constructor(readonly aws: AwsClient) {}
	host(bucket: string) {
		if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))
			throw new Error("Invalid receiving bucket");
		return `${bucket}.s3.${this.aws.config.region}.${awsSuffix(this.aws.config.region)}`;
	}
	async listBuckets() {
		await this.aws.empty({
			service: "s3",
			host: `s3.${this.aws.config.region}.${awsSuffix(this.aws.config.region)}`,
		});
	}
	async exists(bucket: string) {
		try {
			await this.aws.empty({
				service: "s3",
				host: this.host(bucket),
				method: "HEAD",
			});
			return true;
		} catch (error) {
			if (error instanceof AwsError && error.status === 404) return false;
			throw error;
		}
	}
	async create(bucket: string) {
		const region = this.aws.config.region,
			body =
				region === "us-east-1"
					? ""
					: `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${escapeXml(region)}</LocationConstraint></CreateBucketConfiguration>`;
		try {
			await this.aws.empty({
				service: "s3",
				host: this.host(bucket),
				method: "PUT",
				body,
			});
		} catch (error) {
			if (
				!(error instanceof AwsError && error.code === "BucketAlreadyOwnedByYou")
			)
				throw error;
		}
	}
	async policy(bucket: string, policy: unknown) {
		await this.aws.empty({
			service: "s3",
			host: this.host(bucket),
			method: "PUT",
			query: { policy: "" },
			body: JSON.stringify(policy),
			headers: { "Content-Type": "application/json" },
		});
	}
	async lifecycle(bucket: string, prefix: string, days: number) {
		const body = `<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Rule><ID>mailflare-expire-inbound</ID><Filter><Prefix>${escapeXml(prefix)}</Prefix></Filter><Status>Enabled</Status><Expiration><Days>${days}</Days></Expiration></Rule></LifecycleConfiguration>`;
		const digest = new Bun.CryptoHasher("sha256").update(body).digest("base64");
		await this.aws.empty({
			service: "s3",
			host: this.host(bucket),
			method: "PUT",
			query: { lifecycle: "" },
			body,
			headers: {
				"Content-Type": "application/xml",
				"x-amz-sdk-checksum-algorithm": "SHA256",
				"x-amz-checksum-sha256": digest,
			},
		});
	}
	path(key: string) {
		if (key.split("/").some((part) => part === "." || part === ".."))
			throw new Error("Unexpected object");
		return "/" + key.split("/").map(encodeURIComponent).join("/");
	}
	get(bucket: string, key: string) {
		return this.aws.request({
			service: "s3",
			host: this.host(bucket),
			path: this.path(key),
		});
	}
	async delete(bucket: string, key: string) {
		await this.aws.empty({
			service: "s3",
			host: this.host(bucket),
			method: "DELETE",
			path: this.path(key),
		});
	}
}
