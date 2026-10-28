import { enqueueContactAvatar, cancelContactAvatar } from "../avatars/jobs";
import { wakeAvatarDispatcher } from "../avatars/dispatcher";
import { z } from "zod";
import { withDatabase, seconds } from "../db";
import {
	normalizeEmailAddress,
	getFirstEmailAddressEntry,
} from "../../lib/email/address";
import {
	getContactId,
	getContactNameFromAddress,
} from "../../lib/contacts/utils";
import type { Message } from "../../hooks/types";
export async function upsertContact(
	userId: string,
	address: string,
	source: "inbound" | "outbound" | "manual",
	mailboxId?: string,
) {
	const email = normalizeEmailAddress(address);
	if (!email) return null;
	const displayName = getContactNameFromAddress(address);
	const row = await withDatabase((sql) =>
		sql.begin(async (sql) => {
			await sql.NativeContactWriteFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
			const [existing] =
				await sql.NativePriorContact`SELECT id FROM contacts WHERE user_id=${userId} AND email=${email}`;
			const [row] =
				await sql.NativeUpsertContact`INSERT INTO contacts (id,user_id,email,display_name,source,last_seen_at,created_at) VALUES (${getContactId(userId, email)},${userId},${email},${displayName},${source},${seconds()},${seconds()}) ON CONFLICT(user_id,email) DO UPDATE SET display_name=CASE WHEN contacts.source='manual' THEN contacts.display_name ELSE COALESCE(excluded.display_name,contacts.display_name) END,source=CASE WHEN contacts.source='manual' OR (contacts.source='outbound' AND excluded.source='inbound') THEN contacts.source ELSE excluded.source END,last_seen_at=excluded.last_seen_at RETURNING id,email,display_name,source,avatar_key,blocked,last_seen_at`;
			if (row)
				await enqueueContactAvatar(sql, row.id, userId, mailboxId, !existing);
			return row;
		}),
	);
	if (row) wakeAvatarDispatcher();
	return row ?? null;
}
export async function messageContacts<T extends Message>(
	userId: string,
	messages: T[],
): Promise<T[]> {
	const emails = [
		...new Set(
			messages
				.flatMap((message) => [
					normalizeEmailAddress(message.fromAddr),
					normalizeEmailAddress(getFirstEmailAddressEntry(message.toAddr)),
				])
				.filter(Boolean),
		),
	];
	if (!emails.length) return messages;
	const rows = await withDatabase(
		(sql) =>
			sql.NativeMessageContactNames`SELECT email,display_name,avatar_key FROM contacts WHERE user_id=${userId} AND email IN(SELECT value FROM json_each(${JSON.stringify(emails)}))`,
	);
	const contacts = new Map(rows.map((row) => [row.email, row]));
	return messages.map((message) => {
		const from = contacts.get(normalizeEmailAddress(message.fromAddr)),
			to = contacts.get(
				normalizeEmailAddress(getFirstEmailAddressEntry(message.toAddr)),
			);
		return {
			...message,
			fromContactName: from?.display_name ?? null,
			toContactName: to?.display_name ?? null,
			fromContactHasAvatar: !!from?.avatar_key,
		};
	});
}
export async function syncPersonalIdentity(
	userId: string,
	name: string,
	avatarKey: string | null,
) {
	const [account] = await withDatabase(
		(sql) =>
			sql.NativeIdentityAccount`SELECT email FROM users WHERE id=${userId}`,
	);
	if (!account) throw new Response("Account not found", { status: 404 });
	await withDatabase((sql) =>
		sql.begin(async (tx) => {
			await tx.NativeSyncAccountIdentity`UPDATE users SET name=${name},avatar_key=${avatarKey} WHERE id=${userId}`;
			await tx.NativeSyncIdentityMailbox`UPDATE mailboxes SET display_name=${name},avatar_key=${avatarKey} WHERE user_id=${userId} AND type='personal' AND EXISTS(SELECT 1 FROM domains d WHERE d.id=mailboxes.domain_id AND lower(mailboxes.local_part||'@'||d.hostname)=lower(${account.email}))`;
			const addresses =
				await tx.NativeIdentityAddresses`/* @notNull email */ SELECT b.local_part||'@'||d.hostname AS email,b.display_name,b.avatar_key FROM mailboxes b JOIN domains d ON d.id=b.domain_id WHERE b.user_id=${userId} AND b.type='personal' UNION SELECT a.local_part||'@'||d.hostname,b.display_name,b.avatar_key FROM mailbox_aliases a JOIN domains d ON d.id=a.domain_id JOIN mailboxes b ON b.id=a.mailbox_id WHERE b.user_id=${userId} AND b.type='personal' UNION SELECT b.local_part||'@'||d.hostname,b.display_name,b.avatar_key FROM mailboxes b JOIN domains origin ON origin.id=b.domain_id JOIN domains d ON d.user_id=origin.user_id WHERE b.user_id=${userId} AND b.type='personal' AND b.use_all_domains=1 AND d.status='active' AND NOT EXISTS(SELECT 1 FROM mailboxes other WHERE other.domain_id=d.id AND other.local_part=b.local_part AND other.id<>b.id)`;
			for (const address of addresses) {
				await tx.NativeSyncIdentityContact`INSERT INTO contacts (id,user_id,email,display_name,avatar_key,source,last_seen_at,created_at) VALUES (${getContactId(userId, z.string().parse(address.email))},${userId},${address.email},${address.display_name ?? name},${address.avatar_key},'manual',${seconds()},${seconds()}) ON CONFLICT(user_id,email) DO UPDATE SET display_name=excluded.display_name,avatar_key=excluded.avatar_key,source='manual'`;
				await cancelContactAvatar(
					tx,
					getContactId(userId, z.string().parse(address.email)),
				);
			}
		}),
	);
}
export async function personalIdentity(userId: string, email: string) {
	const [row] = await withDatabase(
		(sql) =>
			sql.NativePersonalAddress`SELECT u.id,u.name,u.avatar_key FROM users u WHERE u.id=${userId} AND EXISTS(SELECT 1 FROM mailboxes b JOIN domains origin ON origin.id=b.domain_id WHERE b.user_id=u.id AND b.type='personal' AND (lower(b.local_part||'@'||origin.hostname)=${email} OR EXISTS(SELECT 1 FROM mailbox_aliases a JOIN domains d ON d.id=a.domain_id WHERE a.mailbox_id=b.id AND lower(a.local_part||'@'||d.hostname)=${email}) OR (b.use_all_domains=1 AND EXISTS(SELECT 1 FROM domains d WHERE d.user_id=origin.user_id AND d.status='active' AND lower(b.local_part||'@'||d.hostname)=${email})))) LIMIT 1`,
	);
	return row
		? z
				.object({
					id: z.string(),
					name: z.string(),
					avatar_key: z.string().nullable(),
				})
				.parse(row)
		: null;
}
