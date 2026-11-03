import { personalMailboxAddresses } from "./identity-addresses";
import { enqueueContactAvatar, cancelContactAvatar } from "../avatars/jobs";
import { wakeAvatarDispatcher } from "../avatars/dispatcher";
import { withDatabase, seconds, type AppSQL } from "../db";
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
	context?: AppSQL,
) {
	const email = normalizeEmailAddress(address);
	if (!email) return null;
	const displayName = getContactNameFromAddress(address);
	const run = async (sql: AppSQL) => {
		await sql.NativeContactWriteFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
		const [existing] =
			await sql.NativePriorContact`SELECT id FROM contacts WHERE user_id=${userId} AND email=${email}`;
		const [row] =
			await sql.NativeUpsertContact`INSERT INTO contacts (id,user_id,email,display_name,source,last_seen_at,created_at) VALUES (${getContactId(userId, email)},${userId},${email},${displayName},${source},${seconds()},${seconds()}) ON CONFLICT(user_id,email) DO UPDATE SET display_name=CASE WHEN contacts.source='manual' THEN contacts.display_name ELSE COALESCE(excluded.display_name,contacts.display_name) END,source=CASE WHEN contacts.source='manual' OR (contacts.source='outbound' AND excluded.source='inbound') THEN contacts.source ELSE excluded.source END,last_seen_at=excluded.last_seen_at RETURNING id,email,display_name,source,avatar_key,blocked,last_seen_at`;
		if (row)
			await enqueueContactAvatar(sql, row.id, userId, mailboxId, !existing);
		return row;
	};
	const row = context
		? await run(context)
		: await withDatabase((sql) => sql.begin(run));
	if (row) wakeAvatarDispatcher();
	return row ?? null;
}
export async function messageContacts<T extends Message>(
	userId: string,
	messages: T[],
	includeAvatar = true,
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
			fromContactName: from?.display_name || null,
			toContactName: to?.display_name || null,
			...(includeAvatar ? { fromContactHasAvatar: !!from?.avatar_key } : {}),
		};
	});
}
export async function syncPersonalIdentity(
	userId: string,
	name: string,
	avatarKey: string | null,
	context?: AppSQL,
) {
	const run = async (tx: AppSQL) => {
		await tx.NativeSyncIdentityFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
		const [account] =
			await tx.NativeIdentityAccount`SELECT email FROM users WHERE id=${userId}`;
		if (!account) throw new Response("Account not found", { status: 404 });
		await tx.NativeSyncAccountIdentity`UPDATE users SET name=${name},avatar_key=${avatarKey} WHERE id=${userId}`;
		for (const box of await personalMailboxAddresses(tx, userId)) {
			const primary =
				`${box.local_part}@${box.hostname}`.trim().toLowerCase() ===
				account.email.trim().toLowerCase();
			if (primary)
				await tx.NativeSyncIdentityMailbox`UPDATE mailboxes SET display_name=${name},avatar_key=${avatarKey} WHERE id=${box.id}`;
			const displayName = primary ? name : (box.display_name ?? name),
				key = primary ? avatarKey : box.avatar_key;
			for (const email of box.addresses) {
				const contactId = getContactId(userId, email);
				await tx.NativeSyncIdentityContact`INSERT INTO contacts (id,user_id,email,display_name,avatar_key,source,created_at) VALUES (${contactId},${userId},${email},${displayName},${key},'manual',${seconds()}) ON CONFLICT(user_id,email) DO UPDATE SET display_name=excluded.display_name,avatar_key=excluded.avatar_key,source='manual'`;
				await cancelContactAvatar(tx, contactId);
			}
		}
	};
	if (context) await run(context);
	else await withDatabase((sql) => sql.begin(run));
}
export async function personalIdentity(
	userId: string,
	email: string,
	context?: AppSQL,
) {
	const run = async (sql: AppSQL) => {
		const [account] =
			await sql.NativePersonalIdentityAccount`SELECT id,name,avatar_key FROM users WHERE id=${userId}`;
		if (!account) return null;
		for (const box of await personalMailboxAddresses(sql, userId))
			if (box.addresses.includes(email)) return account;
		return null;
	};
	return context ? run(context) : withDatabase(run);
}
