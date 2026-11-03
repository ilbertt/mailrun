import type { z } from "zod";
import type { deliveryPayloadSchema } from "../../shared/mail-contracts";
import {
	formatMessageIdHeader,
	normalizeMessageId,
	parseMessageIdList,
} from "../../lib/email/threading";

export function deliveryHeaders(
	payload: Pick<
		z.output<typeof deliveryPayloadSchema>,
		| "headers"
		| "inReplyTo"
		| "references"
		| "autoReplyMailboxId"
		| "autoReplyRecipient"
	>,
): Record<string, string> {
	const headers = { ...payload.headers };
	if (payload.autoReplyMailboxId && payload.autoReplyRecipient) {
		headers["Auto-Submitted"] = "auto-replied";
		headers["X-Auto-Response-Suppress"] = "All";
	}
	const parent = normalizeMessageId(payload.inReplyTo);
	if (parent) headers["In-Reply-To"] = formatMessageIdHeader([parent]);
	// The original persisted queue accepts both forms. Array order (including
	// repeated IDs) is retained; header strings use the source's list parser.
	const references = Array.isArray(payload.references)
		? payload.references
				.map(normalizeMessageId)
				.filter((id): id is string => !!id)
		: parseMessageIdList(payload.references);
	if (references.length) headers.References = formatMessageIdHeader(references);
	if (
		Buffer.byteLength(
			Object.entries(headers)
				.map(([name, value]) => `${name}: ${value}\r\n`)
				.join(""),
		) >
		16 * 1024
	)
		throw new Error("Headers exceed Cloudflare's 16 KB limit");
	return headers;
}
