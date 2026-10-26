import { getUser } from "../auth/service";
import { sessionToken } from "../auth/request-token";
import { publicOrigin } from "../config";
import { driveApi } from "./drive";
import { apiErrorResponse } from "./errors";
export const isDriveUploadPath = (path: string) =>
	/^\/api\/drive\/upload(?:\/[^/]+)?$/.test(path);
/** Streaming file transfers do not need the page-rendering request context. */
export async function serveDriveUpload(request: Request): Promise<Response> {
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
			(await driveApi(request, user)) ??
			Response.json({ error: "Not found" }, { status: 404 })
		);
	} catch (error) {
		return apiErrorResponse(error);
	}
}
