import { z } from "zod";
import type { AwsConfig } from "../../lib/aws/aws-types";
import type { CloudflareFetch } from "../cloudflare/client";
import type { OutboundMail } from "../mail/provider";
import { base64Blob } from "../mail/attachment-stream";
import { stageSendBody } from "../mail/sending-staging";
import { AwsClient } from "./client";
import { SesClient } from "./ses";
async function* body(message: OutboundMail) {
	const encode = new TextEncoder();
	const headers = Object.entries(message.headers ?? {})
		.filter(([name]) => name.toLowerCase() !== "message-id")
		.map(([Name, Value]) => ({ Name, Value }));
	const envelope = {
		FromEmailAddress: message.from,
		Destination: {
			ToAddresses: message.to,
			...(message.cc?.length ? { CcAddresses: message.cc } : {}),
			...(message.bcc?.length ? { BccAddresses: message.bcc } : {}),
		},
	};
	const simple = {
		Subject: { Data: message.subject, Charset: "UTF-8" },
		Body: {
			...(message.text
				? { Text: { Data: message.text, Charset: "UTF-8" } }
				: {}),
			...(message.html
				? { Html: { Data: message.html, Charset: "UTF-8" } }
				: {}),
		},
		...(headers.length ? { Headers: headers } : {}),
	};
	yield encode.encode(
		JSON.stringify(envelope).slice(0, -1) +
			',"Content":{"Simple":' +
			JSON.stringify(simple).slice(0, -1),
	);
	if (message.attachments?.length) {
		yield encode.encode(',"Attachments":[');
		for (const [index, attachment] of message.attachments.entries()) {
			if (index) yield encode.encode(",");
			yield encode.encode(
				JSON.stringify({
					FileName: attachment.filename,
					ContentType: attachment.type,
					ContentDisposition:
						attachment.disposition === "inline" ? "INLINE" : "ATTACHMENT",
					...(attachment.disposition === "inline" && attachment.contentId
						? { ContentId: attachment.contentId }
						: {}),
					ContentTransferEncoding: "BASE64",
				}).slice(0, -1) + ',"RawContent":"',
			);
			if (typeof attachment.content === "string")
				yield encode.encode(attachment.content);
			else
				for await (const chunk of base64Blob(attachment.content))
					yield encode.encode(chunk);
			yield encode.encode('"}');
		}
		yield encode.encode("]");
	}
	yield encode.encode("}}}");
}
export async function sendSesMail(
	config: AwsConfig,
	message: OutboundMail,
	send: CloudflareFetch = fetch,
) {
	const client = new AwsClient(config, send),
		ses = new SesClient(client),
		staged = await stageSendBody(body(message));
	try {
		const response = await client.json(
			z.object({ MessageId: z.string().min(1) }),
			{
				...ses.endpoint("/v2/email/outbound-emails"),
				method: "POST",
				body: staged.file,
				payloadHash: staged.payloadHash,
			},
		);
		const domain =
			config.region === "us-east-1"
				? "email.amazonses.com"
				: `${config.region}.amazonses.com`;
		return { messageId: `<${response.MessageId}@${domain}>` };
	} finally {
		await staged
			.close()
			.catch(() => console.warn("Could not remove SES send staging file"));
	}
}
