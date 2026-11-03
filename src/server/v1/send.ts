import type { ApiPrincipal } from "../auth/key-principal";
import { assertApiPrincipal } from "../auth/key-principal";
import { withDatabase } from "../db";
import { sendEmailSchema } from "../../lib/validators";
import {
	queueSourceSend,
	type SourceSendAttachment,
} from "../mail/session-send";
import { deliverJob } from "../mail/send";
import { publicOrigin } from "../config";
import type { CloudflareFetch } from "../cloudflare/client";
export async function v1Send(
	user: ApiPrincipal,
	value: unknown,
	request: CloudflareFetch = fetch,
	origin = publicOrigin(),
) {
	const input = sendEmailSchema.parse(value);
	await withDatabase((sql) => assertApiPrincipal(sql, user, input.mailboxId));
	// Original v1 decodes every attachment before authorizing the sender.
	const files: SourceSendAttachment[] = (input.attachments ?? []).map(
		(file) => {
			let binary: string;
			try {
				binary = atob(file.contentBase64.replace(/\s/g, ""));
			} catch (error) {
				// Bun and Node use different text for the same InvalidCharacterError.
				if (
					error instanceof DOMException &&
					error.name === "InvalidCharacterError"
				)
					throw new Error("Invalid character");
				throw error;
			}
			const bytes = new Uint8Array(binary.length);
			for (let index = 0; index < binary.length; index++)
				bytes[index] = binary.charCodeAt(index);
			return {
				filename: file.filename,
				type: file.type,
				blob: new Blob([bytes]),
				disposition: "attachment",
			};
		},
	);
	const { attachments: _attachments, ...fields } = input;
	const queued = await queueSourceSend(
		user,
		fields,
		files,
		origin,
		undefined,
		async (sql) => {
			await assertApiPrincipal(sql, user, input.mailboxId);
		},
	);
	if (!queued.scheduled) await deliverJob(queued.jobId, request);
	return {
		messageId: queued.messageId,
		...(queued.scheduled ? { scheduled: true } : {}),
	};
}
