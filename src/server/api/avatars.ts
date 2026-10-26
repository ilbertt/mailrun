import { imageResponse, storeImages } from "../images";
import { licenseEntitlements } from "../licenses";
import { z } from "zod";
import type { User } from "../../shared/contracts";
import { withDatabase } from "../db";
import { mailboxAccess } from "../mail/access";
import { LocalStorage } from "../storage";
import {
	personalIdentity,
	syncPersonalIdentity,
	upsertContact,
} from "../mail/contacts";
import { normalizeEmailAddress } from "../../lib/email/address";
import { getContactId } from "../../lib/contacts/utils";
import { currentProfile } from "./settings";
export async function avatarsApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	const url = new URL(request.url),
		path = url.pathname,
		method = request.method;
	const mailboxMatch = /^\/api\/mailboxes\/([^/]+)\/avatar$/.exec(path);
	const userMatch = /^\/api\/auth\/accounts\/([^/]+)\/avatar$/.exec(path);
	const managedMatch = /^\/api\/accounts\/([^/]+)\/avatar$/.exec(path);
	if (
		path !== "/api/profile/avatar" &&
		path !== "/api/contacts/avatar" &&
		!mailboxMatch &&
		!userMatch &&
		!managedMatch
	)
		return null;
	if (managedMatch) {
		if (method !== "GET") return null;
		if (
			user.role !== "admin" ||
			!(await licenseEntitlements()).canManageAccounts
		)
			throw new Response("Forbidden", { status: 403 });
		const [account] = await withDatabase(
			(sql) =>
				sql.NativeBookingHostAvatar`SELECT avatar_key FROM users WHERE id=${decodeURIComponent(managedMatch[1] ?? "")}`,
		);
		return account?.avatar_key
			? imageResponse(request, account.avatar_key)
			: new Response("Not found", { status: 404 });
	}
	const storage = new LocalStorage();
	let key: string | null = null;
	let save: (key: string | null) => Promise<unknown>;
	if (userMatch) {
		if (method !== "GET") return null;
		// Account switcher may read only the current account or accounts signed into this browser.
		const target = decodeURIComponent(userMatch[1] ?? "");
		if (target !== user.id) {
			const { browserAccounts } = await import("../auth/browser-accounts");
			if (
				!(await browserAccounts()).some((account) => account.userId === target)
			)
				throw new Response("Forbidden", { status: 403 });
		}
		const [row] = await withDatabase(
			(sql) =>
				sql.NativeUserAvatar`SELECT avatar_key FROM users WHERE id=${target} AND disabled=0`,
		);
		return row?.avatar_key
			? imageResponse(request, row.avatar_key)
			: new Response("Not found", { status: 404 });
	}
	if (mailboxMatch) {
		const box = await mailboxAccess(
			user,
			decodeURIComponent(mailboxMatch[1] ?? ""),
			method === "GET" ? "read" : "manage",
		);
		const [row] = await withDatabase(
			(sql) =>
				sql.NativeMailboxAvatar`SELECT b.avatar_key,u.avatar_key AS owner_avatar,u.name FROM mailboxes b JOIN users u ON u.id=b.user_id WHERE b.id=${box.id}`,
		);
		if (!row) throw new Response("Mailbox not found", { status: 404 });
		const primary =
			box.type === "personal" &&
			`${box.local_part}@${box.hostname}`.toLowerCase() ===
				box.owner_email?.toLowerCase();
		key = primary ? row.owner_avatar : row.avatar_key;
		save = primary
			? (value) => syncPersonalIdentity(box.user_id, row.name, value)
			: (value) =>
					withDatabase(
						(sql) =>
							sql.NativeSetMailboxAvatar`UPDATE mailboxes SET avatar_key=${value} WHERE id=${box.id}`,
					);
		if (method === "POST") key = `avatars/mailboxes/${box.id}.webp`;
	} else if (path === "/api/profile/avatar") {
		const profile = await currentProfile(user);
		key = profile.avatar_key;
		save = (value) => syncPersonalIdentity(user.id, profile.name, value);
		if (method === "POST") key = `avatars/users/${user.id}.webp`;
	} else {
		let form: FormData | null = null;
		if (method === "POST") form = await request.formData();
		const mailboxId = z
			.string()
			.min(1)
			.parse(form?.get("mailboxId") ?? url.searchParams.get("mailboxId"));
		const email = normalizeEmailAddress(
			z.string().parse(form?.get("address") ?? url.searchParams.get("address")),
		);
		if (!z.email().safeParse(email).success)
			throw new Response("A valid contact email is required", { status: 400 });
		const box = await mailboxAccess(
				user,
				mailboxId,
				method === "GET" ? "read" : "manage",
			),
			identity = await personalIdentity(box.user_id, email);
		const [contact] = await withDatabase(
			(sql) =>
				sql.NativeContactAvatar`SELECT avatar_key FROM contacts WHERE user_id=${box.user_id} AND email=${email}`,
		);
		key = identity?.avatar_key ?? contact?.avatar_key ?? null;
		if (identity && method !== "GET" && identity.id !== user.id)
			throw new Response("Only the account owner can change this contact", {
				status: 403,
			});
		save = async (value) => {
			if (identity)
				await syncPersonalIdentity(
					identity.id,
					z.string().parse(identity.name),
					value,
				);
			await upsertContact(box.user_id, email, "manual");
			await withDatabase(
				(sql) =>
					sql.NativeSetContactAvatar`UPDATE contacts SET avatar_key=${value} WHERE user_id=${box.user_id} AND email=${email}`,
			);
		};
		if (method === "POST") {
			key = `avatars/contacts/${encodeURIComponent(getContactId(box.user_id, email))}.webp`;
			return await storeImages(form!, key, save);
		}
	}
	if (method === "GET")
		return key
			? imageResponse(request, key)
			: new Response("Not found", { status: 404 });
	if (method === "POST")
		return storeImages(await request.formData(), key!, save);
	if (method === "DELETE") {
		await save(null);
		if (key)
			await Promise.all([
				storage.delete(key),
				storage.delete(key + ":preview"),
			]);
		return Response.json({ ok: true });
	}
	return null;
}
