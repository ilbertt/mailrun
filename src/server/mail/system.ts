import { withDatabase } from "../db";
import { getInstallation } from "../cloudflare/installation";
import { cloudflare, type CloudflareFetch } from "../cloudflare/client";
import { formatEmailAddress } from "../../lib/email/address";
import { z } from "zod";
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
	const installation = await getInstallation();
	if (!installation) return false;
	const rows = await withDatabase(
			(sql) =>
				sql.NativeSystemMailSenders`SELECT b.local_part,b.display_name,d.hostname,u.role FROM mailboxes b JOIN domains d ON d.id=b.domain_id JOIN users u ON u.id=b.user_id WHERE b.disabled=0 AND u.disabled=0 AND d.sending_provider='cloudflare' AND d.sending_enabled=1 AND (${input.hostname ?? null} IS NULL OR d.hostname=${input.hostname?.toLowerCase() ?? null}) ORDER BY b.created_at,b.rowid LIMIT 50`,
		),
		sender = rows.find((row) => row.role === "admin") ?? rows[0];
	if (!sender) return false;
	await cloudflare(
		installation.api_token,
		`/accounts/${installation.account_id}/email/sending/send`,
		z.object({ message_id: z.string() }),
		{
			method: "POST",
			body: JSON.stringify({
				from: formatEmailAddress(
					`${sender.local_part}@${sender.hostname}`,
					sender.display_name ?? "Mailflare",
				),
				to: [input.to],
				subject: input.subject,
				text: input.text,
				html: input.html,
				headers: {
					"Auto-Submitted": "auto-generated",
					"X-Auto-Response-Suppress": "All",
				},
			}),
		},
		send,
	);
	return true;
}
