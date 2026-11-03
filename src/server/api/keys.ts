import type { User } from "../../shared/contracts";
import {
	createManagedKey,
	listManagedKeys,
	revokeManagedKey,
} from "../auth/key-management";
import { readLimitedBody } from "../mail/inbound";
export async function keysApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	const url = new URL(request.url),
		path = url.pathname,
		kind =
			path === "/api/api-keys"
				? "personal"
				: path === "/api/admin/api-keys"
					? "admin"
					: path === "/api/agent/mcp-keys"
						? "mcp"
						: null;
	if (!kind) return null;
	if (request.method === "GET") {
		const keys = await listManagedKeys(user, kind);
		return Response.json(kind === "mcp" ? { keys } : { apiKeys: keys }, {
			headers: { "Cache-Control": "no-store" },
		});
	}
	if (request.method === "POST") {
		const created = await createManagedKey(
			user,
			kind,
			JSON.parse(
				new TextDecoder().decode(await readLimitedBody(request, 32 * 1024)),
			),
		);
		return Response.json(kind === "admin" ? { key: created.key } : created, {
			headers: { "Cache-Control": "no-store" },
		});
	}
	if (request.method === "DELETE") {
		const id = url.searchParams.get("id");
		if (!id) throw new Response("Key required", { status: 400 });
		return Response.json(await revokeManagedKey(user, kind, id));
	}
	return null;
}
