import type { User } from "../../shared/contracts";
import { getUser } from "../auth/service";
import { sessionToken } from "../auth/request-token";
import { publicOrigin } from "../config";
import { apiErrorResponse } from "./errors";
export async function serveSessionApi(
	request: Request,
	handler: (request: Request, user: User) => Promise<Response | null>,
) {
	try {
		const origin = request.headers.get("origin"),
			bearer = request.headers
				.get("authorization")
				?.match(/^Bearer (.+)$/)?.[1];
		if (
			!["GET", "HEAD", "OPTIONS"].includes(request.method) &&
			origin !== publicOrigin() &&
			(origin !== null || !bearer)
		)
			throw new Response("Invalid origin", { status: 403 });
		const user = await getUser(sessionToken(request));
		if (!user) throw new Response("Unauthorized", { status: 401 });
		return (
			(await handler(request, user)) ??
			Response.json({ error: "Not found" }, { status: 404 })
		);
	} catch (error) {
		return apiErrorResponse(error);
	}
}
