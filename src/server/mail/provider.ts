import { OutboundProviderError } from "./provider-error";
import { z } from "zod";
import { withDatabase } from "../db";
import { getEmailAddress } from "../../lib/email/address";
import { getInstallation } from "../cloudflare/installation";
import { cloudflare, type CloudflareFetch } from "../cloudflare/client";
import { ResendClient } from "../resend/client";
import { requireResendKey } from "../resend/settings";
export type OutboundConfig =
	| { provider: "cloudflare"; apiToken: string; accountId: string }
	| { provider: "resend"; apiKey: string };
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
		throw new OutboundProviderError("Amazon SES sending is not configured");
	const installation = await getInstallation();
	if (!installation)
		throw new OutboundProviderError("Cloudflare email is not configured");
	if (!row.sending_enabled || row.status !== "active")
		throw new OutboundProviderError(
			"Cloudflare sending is not enabled for this domain",
		);
	return {
		provider: "cloudflare",
		apiToken: installation.api_token,
		accountId: installation.account_id,
	};
}
async function* base64(file: Blob) {
	const reader = file.stream().getReader();
	let carry = new Uint8Array(0);
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			const bytes = carry.length
					? Buffer.concat([carry, chunk.value])
					: Buffer.from(
							chunk.value.buffer,
							chunk.value.byteOffset,
							chunk.value.byteLength,
						),
				length = bytes.length - (bytes.length % 3);
			if (length) yield bytes.subarray(0, length).toString("base64");
			carry = Uint8Array.from(bytes.subarray(length));
		}
		if (carry.length) yield Buffer.from(carry).toString("base64");
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
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
				for await (const chunk of base64(attachment.content))
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
	if (config.provider === "cloudflare") {
		const body = JSON.stringify(message);
		if (Buffer.byteLength(body) > 5 * 1024 * 1024)
			throw new Error("Message exceeds Cloudflare's 5 MiB API limit");
		const result = await cloudflare(
			config.apiToken,
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
	const iterator = resendBody(message, headers);
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await iterator.next();
				if (next.done) controller.close();
				else controller.enqueue(next.value);
			} catch (error) {
				controller.error(error);
			}
		},
		async cancel() {
			await iterator.return();
		},
	});
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
