import { driveApi } from "./drive";
import { serveSessionApi } from "./session";
export const isDriveUploadPath = (path: string) =>
	/^\/api\/drive\/upload(?:\/[^/]+)?$/.test(path);
/** Streaming file transfers do not need the page-rendering request context. */
export function serveDriveUpload(request: Request) {
	return serveSessionApi(request, driveApi);
}
