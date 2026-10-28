import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { CloudflareFetch } from "../src/server/cloudflare/client";
export const fixtureAwsConfig = {
	accessKeyId: "AKIAFIXTURE1234567890",
	secretAccessKey: "synthetic-aws-secret-fixture-2026",
	region: "us-east-1",
};
const xml = (body: string) =>
	new Response(body, { headers: { "Content-Type": "text/xml" } });
const escape = (value: string) =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const encode = (value: string) =>
	[...Buffer.from(value)]
		.map((byte) =>
			/[A-Za-z0-9_~.-]/.test(String.fromCharCode(byte))
				? String.fromCharCode(byte)
				: "%" + byte.toString(16).toUpperCase().padStart(2, "0"),
		)
		.join("");
export function verifyAwsSignature(
	request: Request,
	bytes: Uint8Array,
	config = fixtureAwsConfig,
) {
	const authorization = request.headers.get("Authorization") ?? "",
		match =
			/^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(
				authorization,
			);
	if (!match || match[1] !== config.accessKeyId) return false;
	const url = new URL(request.url),
		headers = match[5]!.split(";"),
		date = request.headers.get("x-amz-date") ?? "",
		service = match[4]!;
	if (date.slice(0, 8) !== match[2] || request.headers.get("host") !== url.host)
		return false;
	const canonicalHeaders = headers
		.map(
			(name) =>
				`${name}:${(request.headers.get(name) ?? "").trim().replace(/\s+/g, " ")}\n`,
		)
		.join("");
	const path =
		service === "s3"
			? url.pathname
			: url.pathname
					.split("/")
					.map((segment) => encode(decodeURIComponent(segment)))
					.join("/");
	const query = [...url.searchParams]
		.map(([name, value]) => [encode(name), encode(value)])
		.sort(([a, av], [b, bv]) =>
			a! < b! ? -1 : a! > b! ? 1 : av! < bv! ? -1 : av! > bv! ? 1 : 0,
		)
		.map(([name, value]) => name + "=" + value)
		.join("&");
	const hash = createHash("sha256").update(bytes).digest("hex");
	if (service === "s3" && request.headers.get("x-amz-content-sha256") !== hash)
		return false;
	const canonical = [
		request.method,
		path,
		query,
		canonicalHeaders,
		headers.join(";"),
		hash,
	].join("\n");
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		date,
		`${match[2]}/${match[3]}/${service}/aws4_request`,
		createHash("sha256").update(canonical).digest("hex"),
	].join("\n");
	let key: Buffer = Buffer.from("AWS4" + config.secretAccessKey);
	for (const value of [match[2]!, match[3]!, service, "aws4_request"])
		key = createHmac("sha256", key).update(value).digest();
	return timingSafeEqual(
		createHmac("sha256", key).update(stringToSign).digest(),
		Buffer.from(match[6]!, "hex"),
	);
}
export function awsFixture() {
	const identities = new Map<string, { verified: boolean; tokens: string[] }>(),
		buckets = new Set<string>(),
		objects = new Map<string, Uint8Array<ArrayBuffer>>(),
		topics = new Map<string, { endpoint: string; confirmed: boolean }[]>(),
		rules = new Map<string, Record<string, string>>(),
		denied = new Set<string>();
	const calls: {
		method: string;
		host: string;
		path: string;
		action: string | null;
		headers: Headers;
		body: unknown;
	}[] = [];
	let activeRuleSet: string | null = null,
		autoVerify = true,
		productionAccess = false,
		invalidCredentials = false,
		sendStatus = 200,
		deleteStatus = 204,
		sequence = 0;
	let onRequest: ((request: Request) => void | Promise<void>) | undefined,
		onSubscribe:
			| ((endpoint: string, topicArn: string) => Promise<void>)
			| undefined;
	const accountId = "123456789012";
	function fail(code: string, status = 403, message = code) {
		return new Response(
			`<ErrorResponse><Error><Code>${code}</Code><Message>${escape(message)}</Message></Error></ErrorResponse>`,
			{ status, headers: { "Content-Type": "text/xml" } },
		);
	}
	function identity(hostname: string) {
		const row = identities.get(hostname);
		return row
			? {
					VerifiedForSendingStatus: row.verified,
					DkimAttributes: {
						Status: row.verified ? "SUCCESS" : "PENDING",
						Tokens: row.tokens,
					},
				}
			: null;
	}
	const send: CloudflareFetch = async (input, init) => {
		const request =
				input instanceof Request && !init ? input : new Request(input, init),
			url = new URL(request.url);
		if (!url.hostname.endsWith(".amazonaws.com"))
			throw new Error("Unexpected external AWS fixture request");
		if (onRequest) await onRequest(request);
		if (
			url.hostname.startsWith("sns.") &&
			request.method === "GET" &&
			url.searchParams.get("Action") === "ConfirmSubscription"
		) {
			if (request.headers.has("Authorization"))
				throw new Error("Credentials forwarded to subscription URL");
			const topic = url.searchParams.get("TopicArn") ?? "";
			for (const row of topics.get(topic) ?? []) row.confirmed = true;
			return xml("<ConfirmSubscriptionResponse/>");
		}
		const bytes = new Uint8Array(await request.arrayBuffer());
		if (invalidCredentials) return fail("InvalidClientTokenId");
		if (!verifyAwsSignature(request, bytes))
			return fail("SignatureDoesNotMatch", 403, "Fixture signature mismatch");
		const text = new TextDecoder().decode(bytes),
			form = new URLSearchParams(text),
			action = request.headers
				.get("Content-Type")
				?.startsWith("application/x-www-form-urlencoded")
				? form.get("Action")
				: null;
		let body: unknown = text;
		if (
			text &&
			request.headers.get("Content-Type")?.startsWith("application/json")
		) {
			try {
				body = JSON.parse(text);
			} catch {
				throw new Error("Malformed AWS JSON request");
			}
		}
		calls.push({
			method: request.method,
			host: url.hostname,
			path: url.pathname,
			action,
			headers: request.headers,
			body,
		});
		const permission =
			action ??
			(url.pathname === "/v2/email/account"
				? "GetAccount"
				: url.pathname.startsWith("/v2/email/identities")
					? "Identity"
					: url.pathname === "/v2/email/outbound-emails"
						? "SendEmail"
						: url.hostname.startsWith("s3.")
							? "ListBuckets"
							: request.method === "DELETE"
								? "DeleteObject"
								: request.method === "GET" && url.pathname !== "/"
									? "GetObject"
									: "Bucket");
		if (denied.has(permission))
			return fail("AccessDenied", 403, "Denied " + permission);
		if (url.hostname.startsWith("sts."))
			return xml(
				`<GetCallerIdentityResponse><GetCallerIdentityResult><Account>${accountId}</Account><Arn>arn:aws:iam::${accountId}:user/fixture</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>`,
			);
		if (url.hostname.startsWith("email.")) {
			if (url.pathname === "/v2/email/account")
				return Response.json({
					ProductionAccessEnabled: productionAccess,
					SendingEnabled: true,
				});
			if (
				url.pathname === "/v2/email/identities" &&
				request.method === "POST"
			) {
				const value = z.object({ EmailIdentity: z.string() }).parse(body);
				if (identities.has(value.EmailIdentity))
					return Response.json(
						{ message: "Exists" },
						{
							status: 409,
							headers: { "x-amzn-errortype": "AlreadyExistsException" },
						},
					);
				identities.set(value.EmailIdentity, {
					verified: autoVerify,
					tokens: ["selector1", "selector2", "selector3"],
				});
				return Response.json(identity(value.EmailIdentity));
			}
			const match = /^\/v2\/email\/identities\/([^/]+)$/.exec(url.pathname);
			if (match) {
				const hostname = decodeURIComponent(match[1]!);
				if (request.method === "DELETE") {
					identities.delete(hostname);
					return new Response(null, { status: 204 });
				}
				const value = identity(hostname);
				return value
					? Response.json(value)
					: Response.json(
							{ message: "Not found" },
							{
								status: 404,
								headers: { "x-amzn-errortype": "NotFoundException" },
							},
						);
			}
			if (url.pathname === "/v2/email/outbound-emails") {
				if (sendStatus !== 200)
					return Response.json(
						{ message: "Synthetic SES send failure" },
						{
							status: sendStatus,
							headers: { "x-amzn-errortype": "MessageRejected" },
						},
					);
				return Response.json({ MessageId: "ses-message-" + ++sequence });
			}
			if (action === "DescribeActiveReceiptRuleSet")
				return xml(
					`<DescribeActiveReceiptRuleSetResponse><DescribeActiveReceiptRuleSetResult>${activeRuleSet ? `<Metadata><Name>${activeRuleSet}</Name></Metadata>` : ""}<Rules>${[...rules.keys()].map((name) => "<member><Name>" + name + "</Name></member>").join("")}</Rules></DescribeActiveReceiptRuleSetResult></DescribeActiveReceiptRuleSetResponse>`,
				);
			if (action === "CreateReceiptRuleSet")
				return xml("<CreateReceiptRuleSetResponse/>");
			if (action === "SetActiveReceiptRuleSet") {
				activeRuleSet = form.get("RuleSetName");
				return xml("<SetActiveReceiptRuleSetResponse/>");
			}
			if (action === "CreateReceiptRule" || action === "UpdateReceiptRule") {
				const name = form.get("Rule.Name") ?? "";
				if (action === "CreateReceiptRule" && rules.has(name))
					return fail("AlreadyExists", 400);
				rules.set(name, Object.fromEntries(form));
				return xml("<RuleResponse/>");
			}
			if (action === "DescribeReceiptRule")
				return rules.has(form.get("RuleName") ?? "")
					? xml("<DescribeReceiptRuleResponse/>")
					: fail("RuleDoesNotExist", 400);
			if (action === "DeleteReceiptRule") {
				rules.delete(form.get("RuleName") ?? "");
				return xml("<DeleteReceiptRuleResponse/>");
			}
		}
		if (url.hostname.startsWith("sns.")) {
			if (action === "ListTopics" || action === "SetTopicAttributes")
				return xml(`<${action}Response/>`);
			if (action === "CreateTopic") {
				const arn = `arn:aws:sns:${fixtureAwsConfig.region}:${accountId}:${form.get("Name")}`;
				if (!topics.has(arn)) topics.set(arn, []);
				return xml(
					`<CreateTopicResponse><TopicArn>${arn}</TopicArn></CreateTopicResponse>`,
				);
			}
			const topic = form.get("TopicArn") ?? "";
			if (action === "Subscribe") {
				const endpoint = form.get("Endpoint") ?? "";
				topics.get(topic)?.push({ endpoint, confirmed: false });
				if (onSubscribe) await onSubscribe(endpoint, topic);
				return xml("<SubscribeResponse/>");
			}
			if (action === "ListSubscriptionsByTopic")
				return xml(
					`<ListSubscriptionsByTopicResponse>${(topics.get(topic) ?? []).map((row) => `<member><Endpoint>${escape(row.endpoint)}</Endpoint><SubscriptionArn>${row.confirmed ? "arn:aws:sns:fixture:subscription" : "PendingConfirmation"}</SubscriptionArn></member>`).join("")}</ListSubscriptionsByTopicResponse>`,
				);
		}
		if (url.hostname.startsWith("s3."))
			return xml("<ListAllMyBucketsResult><Buckets/></ListAllMyBucketsResult>");
		const bucketMatch = /^(.+)\.s3\.[a-z0-9-]+\.amazonaws\.com$/.exec(
			url.hostname,
		);
		if (bucketMatch) {
			const bucket = bucketMatch[1]!;
			if (url.pathname === "/") {
				if (request.method === "HEAD")
					return buckets.has(bucket)
						? new Response(null)
						: fail("NoSuchBucket", 404);
				if (request.method === "PUT") {
					buckets.add(bucket);
					return new Response(null);
				}
			}
			const objectKey = url.pathname
					.slice(1)
					.split("/")
					.map(decodeURIComponent)
					.join("/"),
				id = bucket + "/" + objectKey;
			if (request.method === "GET") {
				const value = objects.get(id);
				return value
					? new Response(value, {
							headers: { "Content-Length": String(value.byteLength) },
						})
					: fail("NoSuchKey", 404);
			}
			if (request.method === "DELETE") {
				if (deleteStatus !== 204) return fail("DeleteFailed", deleteStatus);
				objects.delete(id);
				return new Response(null, { status: 204 });
			}
		}
		throw new Error(
			"Unhandled AWS fixture path " +
				request.method +
				" " +
				url.hostname +
				url.pathname +
				" " +
				action,
		);
	};
	return {
		send,
		calls,
		identities,
		buckets,
		objects,
		topics,
		rules,
		denied,
		accountId,
		get activeRuleSet() {
			return activeRuleSet;
		},
		set activeRuleSet(value: typeof activeRuleSet) {
			activeRuleSet = value;
		},
		set autoVerify(value: boolean) {
			autoVerify = value;
		},
		set productionAccess(value: boolean) {
			productionAccess = value;
		},
		set invalidCredentials(value: boolean) {
			invalidCredentials = value;
		},
		set sendStatus(value: number) {
			sendStatus = value;
		},
		set deleteStatus(value: number) {
			deleteStatus = value;
		},
		get onRequest() {
			return onRequest;
		},
		set onRequest(value: typeof onRequest) {
			onRequest = value;
		},
		set onSubscribe(value: typeof onSubscribe) {
			onSubscribe = value;
		},
	};
}
