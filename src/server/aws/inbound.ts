import { z } from "zod";
import { withDatabase, seconds } from "../db";
import type { CloudflareFetch } from "../cloudflare/client";
import { readLimitedBody } from "../mail/inbound";
import {
	intakeProviderMail,
	MAX_PROVIDER_MESSAGE_BYTES,
} from "../mail/provider-intake";
import {
	getSesReceivingState,
	requireAwsConfig,
	getAwsConfig,
} from "./settings";
import { AwsClient, AwsError } from "./client";
import { S3Client } from "./services";
import { SES_OBJECT_PREFIX } from "./domains";
const resultSchema = z.object({
	delivered: z.number().int().nonnegative(),
	dropped: z.string().nullable(),
});
const envelopeSchema = z.object({
	Type: z.string().optional(),
	TopicArn: z.string().optional(),
	Message: z.string().optional(),
	SubscribeURL: z.string().optional(),
});
const notificationSchema = z.object({
	notificationType: z.literal("Received"),
	mail: z
		.object({
			source: z.string().optional(),
			destination: z.array(z.string()).optional(),
			headers: z
				.array(z.object({ name: z.string(), value: z.string() }))
				.optional(),
		})
		.optional(),
	receipt: z.object({
		recipients: z.array(z.string()).optional(),
		virusVerdict: z.object({ status: z.string().optional() }).optional(),
		action: z.object({
			type: z.literal("S3"),
			bucketName: z.string().min(1),
			objectKey: z.string().min(1),
		}),
	}),
});
function safeEqual(a: string, b: string) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let index = 0; index < a.length; index++)
		diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return diff === 0;
}
function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
async function receiptResult(id: string) {
	const [stored] = await withDatabase(
		(sql) =>
			sql.NativeSesReceipt`SELECT result_json FROM mailrun_ses_receipts WHERE id=${id}`,
	);
	return stored ? resultSchema.parse(parseJson(stored.result_json)) : null;
}
export async function sesInbound(
	request: Request,
	send: CloudflareFetch = fetch,
) {
	const json = (body: unknown, status = 200) =>
		Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
	const state = await getSesReceivingState(),
		token = new URL(request.url).searchParams.get("token") ?? "";
	if (!state || !safeEqual(token, state.token))
		return json({ error: "Forbidden" }, 403);
	let rawEnvelope: Uint8Array<ArrayBuffer>;
	try {
		rawEnvelope = await readLimitedBody(request, 256 * 1024);
	} catch {
		return json({ error: "Request body too large" }, 413);
	}
	const envelope = envelopeSchema.safeParse(
		parseJson(new TextDecoder().decode(rawEnvelope)),
	);
	if (!envelope.success) return json({ error: "Invalid body" }, 400);
	if (envelope.data.TopicArn !== state.topicArn)
		return json({ error: "Unknown topic" }, 403);
	try {
		if (envelope.data.Type === "SubscriptionConfirmation") {
			let url: URL;
			try {
				url = new URL(envelope.data.SubscribeURL ?? "");
			} catch {
				return json({ error: "Invalid subscription URL" }, 400);
			}
			if (
				url.protocol !== "https:" ||
				url.username ||
				url.password ||
				url.hostname !== `sns.${state.region}.amazonaws.com` ||
				url.searchParams.get("Action") !== "ConfirmSubscription" ||
				url.searchParams.get("TopicArn") !== state.topicArn
			)
				return json({ error: "Invalid subscription URL" }, 400);
			const confirmed = await send(url, {
				redirect: "manual",
				signal: AbortSignal.timeout(30_000),
			});
			await confirmed.body?.cancel();
			return json({ confirmed: confirmed.ok }, confirmed.ok ? 200 : 502);
		}
		if (envelope.data.Type !== "Notification") return json({ ignored: true });
		const parsed = notificationSchema.safeParse(
			parseJson(envelope.data.Message ?? ""),
		);
		if (!parsed.success) return json({ ignored: true });
		const notification = parsed.data,
			key = notification.receipt.action.objectKey;
		if (
			notification.receipt.action.bucketName !== state.bucket ||
			!key.startsWith(SES_OBJECT_PREFIX) ||
			key.split("/").some((part) => part === "." || part === "..")
		)
			return json({ error: "Unexpected object" }, 400);
		const receiptId = new Bun.CryptoHasher("sha256")
			.update(JSON.stringify([state.topicArn, state.bucket, key]))
			.digest("hex");
		const stored = await receiptResult(receiptId);
		const config = await getAwsConfig();
		if (stored) {
			if (config?.region === state.region)
				await new S3Client(new AwsClient(config, send))
					.delete(state.bucket, key)
					.catch((error) => {
						if (!(error instanceof AwsError && error.status === 404))
							throw error;
					});
			return notification.receipt.virusVerdict?.status === "FAIL"
				? json({ dropped: stored.dropped })
				: json(stored);
		}
		if (!config)
			throw new Error("AWS is selected but no credentials are configured");
		if (config.region !== state.region)
			return json(
				{
					error:
						"SES receiving configuration does not match the saved AWS region",
				},
				503,
			);
		const client = new AwsClient(config, send),
			s3 = new S3Client(client);
		let result: z.infer<typeof resultSchema>;
		if (notification.receipt.virusVerdict?.status === "FAIL")
			result = { delivered: 0, dropped: "Message failed the virus scan" };
		else {
			let response: Response;
			try {
				response = await s3.get(state.bucket, key);
			} catch (error) {
				if (error instanceof AwsError && error.status === 404) {
					const committed = await receiptResult(receiptId);
					if (committed) return json(committed);
				}
				throw error;
			}
			if (
				Number(response.headers.get("Content-Length")) >
				MAX_PROVIDER_MESSAGE_BYTES
			) {
				await response.body?.cancel();
				result = {
					delivered: 0,
					dropped: "Message exceeds the 25 MiB receiving limit",
				};
			} else {
				let raw: Uint8Array<ArrayBuffer> | null;
				try {
					raw = await readLimitedBody(
						new Request("https://mailrun-provider.invalid", {
							method: "POST",
							body: response.body,
						}),
						MAX_PROVIDER_MESSAGE_BYTES,
					);
				} catch (error) {
					if (error instanceof Error && error.message === "Message too large")
						raw = null;
					else throw error;
				}
				result = raw
					? await intakeProviderMail({
							from: notification.mail?.source ?? "",
							recipients:
								notification.receipt.recipients ??
								notification.mail?.destination ??
								[],
							headers: Object.fromEntries(
								(notification.mail?.headers ?? []).map((row) => [
									row.name.toLowerCase(),
									row.value,
								]),
							),
							raw,
						})
					: {
							delivered: 0,
							dropped: "Message exceeds the 25 MiB receiving limit",
						};
			}
		}
		// Persist completion before deleting the temporary object. A lost HTTP ACK
		// must not make a later SNS retry depend on an object already consumed.
		await withDatabase(
			(sql) =>
				sql.NativeRecordSesReceipt`INSERT INTO mailrun_ses_receipts(id,result_json,created_at) VALUES(${receiptId},${JSON.stringify(result)},${seconds()}) ON CONFLICT(id) DO NOTHING`,
		);
		await s3.delete(state.bucket, key);
		return notification.receipt.virusVerdict?.status === "FAIL"
			? json({ dropped: result.dropped })
			: json(result);
	} catch (error) {
		const config = await requireAwsConfig().catch(() => null);
		let message = error instanceof Error ? error.message : "SES intake failed";
		if (config) message = new AwsClient(config).redact(message);
		message = message
			.replaceAll(state.token, "[redacted]")
			.replace(/https?:\/\/[^\s)]+/g, "[redacted URL]");
		return json({ error: message }, 502);
	}
}
