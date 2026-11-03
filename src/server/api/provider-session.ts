import { serveSessionApi } from "./session";
import { domainsApi } from "./domains";
import { awsApi } from "./aws";
import { resendKeyApi } from "./resend-key";
export const isProviderControlPath = (path: string) =>
	path === "/api/domains" ||
	path.startsWith("/api/domains/") ||
	path === "/api/admin/aws" ||
	path === "/api/admin/resend-key";
/** Provider setup can outlast the ordinary HTTP idle timeout; authenticate first. */
export async function serveProviderControl(
	request: Request,
	onAuthorized?: () => void,
) {
	const response = await serveSessionApi(request, async (current, user) => {
		onAuthorized?.();
		return (
			(await awsApi(current, user)) ??
			(await resendKeyApi(current, user)) ??
			(await domainsApi(current, user))
		);
	});
	const headers = new Headers(response.headers);
	headers.set("Cache-Control", "no-store");
	headers.set("X-Content-Type-Options", "nosniff");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
