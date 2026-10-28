import { withDatabase } from "../db";
import { outboundConfig, sendThroughProvider } from "./provider";
import type { CloudflareFetch } from "../cloudflare/client";
import { formatEmailAddress } from "../../lib/email/address";
export type SystemMail = {
	to: string;
	subject: string;
	text: string;
	html: string;
	hostname?: string;
};
export async function sendSystemMail(
	input: SystemMail,
	send: CloudflareFetch = fetch,
) {
	const rows = await withDatabase(
			(sql) =>
				sql.NativeSystemMailSenders`SELECT b.local_part,b.display_name,d.hostname,u.role FROM mailboxes b JOIN domains d ON d.id=b.domain_id JOIN users u ON u.id=b.user_id WHERE b.disabled=0 AND u.disabled=0 AND d.sending_provider<>'none' AND (d.sending_provider<>'cloudflare' OR d.sending_enabled=1) AND (${input.hostname ?? null} IS NULL OR d.hostname=${input.hostname?.toLowerCase() ?? null}) ORDER BY b.created_at,b.rowid LIMIT 50`,
		),
		sender = rows.find((row) => row.role === "admin") ?? rows[0];
	if (!sender) return false;
	const from = formatEmailAddress(
		`${sender.local_part}@${sender.hostname}`,
		sender.display_name ?? "Mailflare",
	);
	await sendThroughProvider(
		await outboundConfig(from),
		{
			from,
			to: [input.to],
			subject: input.subject,
			text: input.text,
			html: input.html,
			headers: {
				"Auto-Submitted": "auto-generated",
				"X-Auto-Response-Suppress": "All",
			},
		},
		send,
	);
	return true;
}
