import { enqueueContactAvatar } from "../avatars/jobs";
import { wakeAvatarDispatcher } from "../avatars/dispatcher";
import { z } from "zod";
import { withDatabase, seconds } from "../db";
import { mailboxAccess, MailboxAccessError } from "../mail/access";
import { personalIdentity, syncPersonalIdentity } from "../mail/contacts";
import { normalizeEmailAddress } from "../../lib/email/address";
import {
	getContactId,
	getContactNameFromAddress,
} from "../../lib/contacts/utils";
import type { User } from "../../shared/contracts";
import { readLimitedBody } from "../mail/inbound";
import { iso } from "../mail/message-query";
export async function contactsApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	const url = new URL(request.url),
		method = request.method,
		block = url.pathname === "/api/contacts/block";
	if (
		!(block
			? method === "POST"
			: url.pathname === "/api/contacts" && ["GET", "PATCH"].includes(method))
	)
		return null;
	const body: unknown =
		method === "GET"
			? {
					mailboxId: url.searchParams.get("mailboxId"),
					address: url.searchParams.get("address"),
				}
			: JSON.parse(
					new TextDecoder().decode(await readLimitedBody(request, 16 * 1024)),
				);
	const input = z
		.object({
			mailboxId: z.string().nullish(),
			address: z.string().nullish(),
			displayName: z.string().nullish(),
		})
		.parse(body);
	const email = normalizeEmailAddress(input.address ?? ""),
		displayName = input.displayName?.trim();
	if (
		method === "PATCH" &&
		(!input.mailboxId || !email || !displayName || displayName.length > 100)
	)
		throw new Response("A valid contact name is required", { status: 400 });
	if (!input.mailboxId || !email)
		throw new Response("Mailbox and contact are required", { status: 400 });
	const mailboxId = input.mailboxId;
	const run = async () =>
		withDatabase((sql) =>
			sql.begin(async (tx) => {
				if (method !== "GET")
					await tx.NativeContactMutationFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
				const box = await mailboxAccess(
					user,
					mailboxId,
					method === "GET" ? "read" : "manage",
					tx,
				);
				if (block) {
					const [existing] =
						await tx.NativePriorBlockedContact`SELECT id FROM contacts WHERE user_id=${box.user_id} AND email=${email}`;
					const contactId = getContactId(box.user_id, email);
					await tx.NativeBlockContact`INSERT INTO contacts (id,user_id,email,display_name,source,blocked,last_seen_at,created_at) VALUES (${contactId},${box.user_id},${email},${getContactNameFromAddress(input.address ?? "")},'inbound',1,${seconds()},${seconds()}) ON CONFLICT(user_id,email) DO UPDATE SET blocked=1`;
					await enqueueContactAvatar(
						tx,
						contactId,
						box.user_id,
						box.id,
						!existing,
					);
					const [rule] =
						await tx.NativeEquivalentBlockRule`SELECT id FROM routing_rules WHERE mailbox_id=${box.id} AND match_field='email' AND match_operator='exact' AND match_value=${email} AND action='trash' LIMIT 1`;
					if (!rule)
						await tx.NativeBlockContactRule`INSERT INTO routing_rules (id,user_id,domain_id,scope,pattern,match_field,match_operator,match_value,action,mailbox_id,priority,created_at) VALUES (${"block:" + box.id + ":" + email},${box.user_id},${box.domain_id},'mailbox',${email},'email','exact',${email},'trash',${box.id},100,${seconds()})`;
					return Response.json({ contact: { email, blocked: true } });
				}
				const identity = await personalIdentity(box.user_id, email, tx);
				if (method === "PATCH" && displayName) {
					if (identity) {
						if (identity.id !== user.id)
							throw new Response(
								"Only the account owner can change this contact",
								{ status: 403 },
							);
						await syncPersonalIdentity(
							identity.id,
							displayName,
							identity.avatar_key,
							tx,
						);
					}
					await tx.NativeSaveManualContact`INSERT INTO contacts (id,user_id,email,display_name,source,created_at) VALUES (${getContactId(box.user_id, email)},${box.user_id},${email},${displayName},'manual',${seconds()}) ON CONFLICT(user_id,email) DO UPDATE SET display_name=excluded.display_name,source='manual'`;
				}
				const [row] =
					await tx.NativeContactDetail`SELECT id,user_id,email,display_name,avatar_key,source,blocked,last_seen_at,created_at FROM contacts WHERE user_id=${box.user_id} AND email=${email}`;
				const contact = row
					? {
							id: row.id,
							userId: row.user_id,
							email: row.email,
							displayName: row.display_name,
							source: row.source,
							blocked: !!row.blocked,
							lastSeenAt: iso(row.last_seen_at),
							createdAt: iso(row.created_at),
							hasAvatar: !!row.avatar_key,
						}
					: null;
				return Response.json({
					contact:
						method === "GET" && identity
							? {
									...contact,
									email,
									displayName: identity.name,
									hasAvatar: !!identity.avatar_key,
									source: "manual",
									blocked: contact?.blocked ?? false,
									lastSeenAt: contact?.lastSeenAt ?? null,
								}
							: (contact ?? {
									email,
									displayName: null,
									hasAvatar: false,
									source: null,
									blocked: false,
									lastSeenAt: null,
								}),
				});
			}),
		);
	try {
		const response = await run();
		if (block) wakeAvatarDispatcher();
		return response;
	} catch (error) {
		if (error instanceof MailboxAccessError)
			throw new Response("Mailbox not found", { status: 404 });
		throw error;
	}
}
