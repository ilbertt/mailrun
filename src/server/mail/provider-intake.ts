import PostalMime from "postal-mime";
import { getEmailAddress } from "../../lib/email/address";
import { parsePostalMime } from "../../lib/email/parse";
import { withDatabase } from "../db";
import { storeInbound } from "./inbound";
export const MAX_PROVIDER_MESSAGE_BYTES = 25 * 1024 * 1024;
const max = MAX_PROVIDER_MESSAGE_BYTES;
export async function intakeProviderMail(input: {
	from: string;
	recipients: string[];
	raw: Uint8Array<ArrayBuffer>;
	headers?: Record<string, string>;
}) {
	if (input.raw.byteLength > max)
		return {
			delivered: 0,
			dropped: "Message exceeds the 25 MiB receiving limit",
		};
	const parsed = await PostalMime.parse(input.raw),
		message = parsePostalMime(parsed);
	let dropped: string | null = null;
	if (message.attachments.length > 10)
		dropped =
			"Message rejected: more than 10 attachments. Send fewer files or a download link.";
	else if (
		message.attachments.some((row) => row.content.byteLength > 25_000_000)
	)
		dropped =
			"Message rejected: an attachment exceeds 25 MB. Send a download link instead.";
	else if (
		message.attachments.reduce((sum, row) => sum + row.content.byteLength, 0) >
		25_000_000
	)
		dropped =
			"Message rejected: attachments exceed 25 MB in total. Send a download link instead.";
	if (dropped) return { delivered: 0, dropped };
	let delivered = 0;
	for (const recipient of new Set(
		input.recipients
			.map((value) => getEmailAddress(value).toLowerCase())
			.filter(Boolean),
	)) {
		const hostname = recipient.slice(recipient.lastIndexOf("@") + 1);
		const [domain] = await withDatabase(
			(sql) =>
				sql.NativeProviderInboundDomain`SELECT id FROM domains WHERE hostname=${hostname} LIMIT 1`,
		);
		if (!domain) continue;
		const result = await storeInbound(
			getEmailAddress(input.from).toLowerCase(),
			recipient,
			input.raw,
			{ provider: true, parsed, headers: input.headers },
		);
		if (result.action === "store" || result.action === "accepted") delivered++;
	}
	return { delivered, dropped: null };
}
