import { cloudflareCredentials } from "../cloudflare/credentials";
import type { CloudflareAuth } from "../../shared/cloudflare-auth";
import type { AwsConfig } from "../../lib/aws/aws-types";
import { requireAwsConfig } from "../aws/settings";
import { sendSesMail } from "../aws/send";
import { base64Blob, iteratorStream } from "./attachment-stream";
import { OutboundProviderError } from "./provider-error";
import { z } from "zod";
import { withDatabase } from "../db";
import { getEmailAddress } from "../../lib/email/address";
import { getInstallation } from "../cloudflare/installation";
import { cloudflare, type CloudflareFetch } from "../cloudflare/client";
import { ResendClient } from "../resend/client";
import { requireResendKey } from "../resend/settings";
export type OutboundConfig =
	| { provider: "cloudflare"; auth: CloudflareAuth; accountId: string }
	| { provider: "resend"; apiKey: string }
	| { provider: "ses"; config: AwsConfig };
export type OutboundAttachment = {
	filename: string;
	type: string;
	content: string | Blob;
	disposition: string;
	contentId?: string;
};
export type OutboundMail = {
	from: string;
	to: string[];
	cc?: string[];
	bcc?: string[];
	subject: string;
	text?: string;
	html?: string;
	headers?: Record<string, string>;
	attachments?: OutboundAttachment[];
};
export async function outboundConfig(address: string): Promise<OutboundConfig> {
	const hostname = getEmailAddress(address).split("@")[1]?.toLowerCase() ?? "";
	const [row] = await withDatabase(
		(sql) =>
			sql.NativeOutboundProvider`SELECT sending_provider,sending_enabled,status FROM domains WHERE hostname=${hostname} LIMIT 1`,
	);
	if (!row || row.sending_provider === "none")
		throw new OutboundProviderError(
			`Sending is not set up for ${hostname || "this domain"}. Choose a sending provider on the Domains page.`,
		);
	const provider = z
		.enum(["cloudflare", "resend", "ses"])
		.parse(row.sending_provider);
	if (provider === "resend")
		return { provider: "resend", apiKey: await requireResendKey() };
	if (provider === "ses")
		return { provider: "ses", config: await requireAwsConfig() };
	const { auth, accountId } = cloudflareCredentials(await getInstallation());
	if (!auth || !accountId)
		throw new OutboundProviderError("Cloudflare email is not configured");
	if (!row.sending_enabled || row.status !== "active")
		throw new OutboundProviderError(
			"Cloudflare sending is not enabled for this domain",
		);
	return {
		provider: "cloudflare",
		auth,
		accountId,
	};
}
async function* resendBody(
	message: OutboundMail,
	headers: Record<string, string>,
) {
	const encoder = new TextEncoder();
	const prefix = JSON.stringify({
		...message,
		cc: message.cc?.length ? message.cc : undefined,
		bcc: message.bcc?.length ? message.bcc : undefined,
		headers,
		attachments: undefined,
	}).slice(0, -1);
	yield encoder.encode(prefix);
	if (message.attachments) {
		yield encoder.encode(',"attachments":[');
		for (const [index, attachment] of message.attachments.entries()) {
			if (index) yield encoder.encode(",");
			yield encoder.encode(
				JSON.stringify({
					filename: attachment.filename,
					content_type: attachment.type,
					...(attachment.disposition === "inline" && attachment.contentId
						? { content_id: attachment.contentId }
						: {}),
				}).slice(0, -1) + ',"content":"',
			);
			if (typeof attachment.content === "string")
				yield encoder.encode(attachment.content);
			else
				for await (const chunk of base64Blob(attachment.content))
					yield encoder.encode(chunk);
			yield encoder.encode('"}');
		}
		yield encoder.encode("]");
	}
	yield encoder.encode("}");
}
export async function sendThroughProvider(
	config: OutboundConfig,
	message: OutboundMail,
	send: CloudflareFetch = fetch,
	idempotencyKey?: string,
) {
	if (config.provider === "ses")
		return sendSesMail(config.config, message, send);
	if (config.provider === "cloudflare") {
		const body = JSON.stringify(message);
		if (Buffer.byteLength(body) > 5 * 1024 * 1024)
			throw new Error("Message exceeds Cloudflare's 5 MiB API limit");
		const result = await cloudflare(
			config.auth,
			`/accounts/${config.accountId}/email/sending/send`,
			z.object({ message_id: z.string() }),
			{ method: "POST", body },
			send,
		);
		return { messageId: result.message_id };
	}
	const domain =
		getEmailAddress(message.from).split("@")[1] || "mailflare.local";
	const nonce = idempotencyKey
		? new Bun.CryptoHasher("sha256").update(idempotencyKey).digest("hex")
		: crypto.randomUUID();
	const messageId = message.headers?.["Message-ID"] ?? `<${nonce}@${domain}>`;
	const headers = { ...message.headers, "Message-ID": messageId };
	const body = iteratorStream(resendBody(message, headers));
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(new Error("Resend send timed out")),
		90_000,
	);
	try {
		await new ResendClient(config.apiKey, send).request(
			"/emails",
			z.object({ id: z.string() }),
			{
				method: "POST",
				body,
				headers: idempotencyKey
					? { "Idempotency-Key": idempotencyKey }
					: undefined,
				signal: controller.signal,
			},
		);
	} finally {
		clearTimeout(timeout);
		controller.abort();
		if (!body.locked) await body.cancel().catch(() => undefined);
	}
	return { messageId };
}
