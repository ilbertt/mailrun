import { z } from "zod";
import { withDatabase, seconds } from "../db";
import { mailboxAccess } from "../mail/access";
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
		path = url.pathname,
		method = request.method;
	if (path !== "/api/contacts" && path !== "/api/contacts/block") return null;
	const body: unknown =
		method === "GET"
			? Object.fromEntries(url.searchParams)
			: JSON.parse(
					new TextDecoder().decode(await readLimitedBody(request, 16 * 1024)),
				);
	const input = z
			.object({
				mailboxId: z.string().min(1),
				address: z.string().max(500),
				displayName: z.string().trim().min(1).max(100).optional(),
			})
			.parse(body),
		email = normalizeEmailAddress(input.address);
	if (!z.email().safeParse(email).success)
		throw new Response("A valid contact email is required", { status: 400 });
	const box = await mailboxAccess(
		user,
		input.mailboxId,
		method === "GET" ? "read" : "manage",
	);
	const identity = await personalIdentity(box.user_id, email);
	if (path === "/api/contacts/block" && method === "POST") {
		await withDatabase((sql) =>
			sql.begin(async (tx) => {
				await tx.NativeBlockContact`INSERT INTO contacts (id,user_id,email,display_name,source,blocked,last_seen_at,created_at) VALUES (${getContactId(box.user_id, email)},${box.user_id},${email},${getContactNameFromAddress(input.address)},'inbound',1,${seconds()},${seconds()}) ON CONFLICT(user_id,email) DO UPDATE SET blocked=1`;
				await tx.NativeBlockContactRule`INSERT INTO routing_rules (id,user_id,domain_id,scope,pattern,match_field,match_operator,match_value,action,mailbox_id,priority,created_at) VALUES (${"block:" + box.id + ":" + email},${box.user_id},${box.domain_id},'mailbox',${email},'email','exact',${email},'trash',${box.id},100,${seconds()}) ON CONFLICT(id) DO NOTHING`;
			}),
		);
		return Response.json({ contact: { email, blocked: true } });
	}
	if (method === "PATCH") {
		if (!input.displayName)
			throw new Response("A valid contact name is required", { status: 400 });
		if (identity) {
			if (identity.id !== user.id)
				throw new Response("Only the account owner can change this contact", {
					status: 403,
				});
			await syncPersonalIdentity(
				identity.id,
				input.displayName,
				identity.avatar_key,
			);
		}
		await withDatabase(
			(sql) =>
				sql.NativeSaveManualContact`INSERT INTO contacts (id,user_id,email,display_name,source,last_seen_at,created_at) VALUES (${getContactId(box.user_id, email)},${box.user_id},${email},${input.displayName},'manual',${seconds()},${seconds()}) ON CONFLICT(user_id,email) DO UPDATE SET display_name=excluded.display_name,source='manual',last_seen_at=excluded.last_seen_at`,
		);
	} else if (method !== "GET") return null;
	const [contact] = await withDatabase(
		(sql) =>
			sql.NativeContactDetail`SELECT email,display_name,avatar_key,source,blocked,last_seen_at FROM contacts WHERE user_id=${box.user_id} AND email=${email}`,
	);
	return Response.json({
		contact: {
			email,
			displayName:
				method === "GET" && identity
					? identity.name
					: (contact?.display_name ?? null),
			hasAvatar:
				method === "GET" && identity
					? !!identity.avatar_key
					: !!contact?.avatar_key,
			source: identity ? "manual" : (contact?.source ?? null),
			blocked: !!contact?.blocked,
			lastSeenAt: iso(contact?.last_seen_at),
		},
	});
}
