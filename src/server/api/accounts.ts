import { withDatabase } from "../db";
import { accountsContext, managedAccount } from "../admin/accounts";
import { syncPersonalIdentity } from "../mail/contacts";
import { storeImages } from "../images";
import type { User } from "../../shared/contracts";
import {
	listAccounts,
	accountDetails,
	createAccount,
	updateAccount,
	transferPrimary,
	accountMailboxes,
} from "../admin/accounts";
export async function accountsApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	const url = new URL(request.url),
		path = url.pathname,
		method = request.method;
	if (path === "/api/accounts") {
		if (method === "GET") return Response.json(await listAccounts(user));
		if (method === "POST")
			return Response.json(await createAccount(user, await request.json()), {
				status: 201,
			});
		return null;
	}
	const match =
		/^\/api\/accounts\/([^/]+)(?:\/(mailboxes|transfer-primary|mailbox-access|avatar))?$/.exec(
			path,
		);
	if (!match) return null;
	const accountId = decodeURIComponent(match[1] ?? ""),
		operation = match[2];
	if (operation === "avatar" && method === "POST") {
		const account = await withDatabase(async (sql) => {
			await accountsContext(sql, user);
			const row = await managedAccount(sql, accountId);
			if (row.id !== user.id && row.created_by_user_id !== user.id)
				throw new Response("Account not found", { status: 404 });
			return row;
		});
		return storeImages(
			await request.formData(),
			`avatars/users/${account.id}.webp`,
			(key) => syncPersonalIdentity(account.id, account.name, key),
		);
	}
	// Mailflare retires this legacy endpoint; sharing uses /api/mailboxes/:id/access.
	if (operation === "mailbox-access")
		return Response.json(
			{ error: "Multiple accounts are not available in this build" },
			{ status: 410 },
		);
	if (operation === "mailboxes" && method === "GET")
		return Response.json(await accountMailboxes(user, accountId));
	if (operation === "transfer-primary" && method === "POST")
		return Response.json(await transferPrimary(user, accountId));
	if (!operation) {
		if (method === "GET")
			return Response.json(await accountDetails(user, accountId));
		if (method === "PATCH")
			return Response.json(
				await updateAccount(user, accountId, await request.json()),
			);
	}
	return null;
}
