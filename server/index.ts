import {
	isDriveUploadPath,
	serveDriveUpload,
} from "../src/server/api/drive-upload";
import { clearDriveRuntimeLeases } from "../src/server/drive/files";
import {
	closeRealtimeConnections,
	realtimeWebsocket,
	type RealtimeSession,
} from "../src/server/realtime";
import { getUser } from "../src/server/auth/service";
import { sessionToken } from "../src/server/auth/request-token";
import { publicOrigin } from "../src/server/config";
import { migrate } from "../src/server/db";
import { runJob } from "../src/server/jobs/runner";
import { registerCrons, cronJobFromArgs } from "../src/server/jobs/cron";
import { getAssetRoutes } from "../src/server/assets";

process.umask(0o077);
await migrate();
const name = cronJobFromArgs(process.argv);
if (name) {
	console.log(JSON.stringify({ job: name, ...(await runJob(name)) }));
} else {
	// Literal imports are bundled into the executable, including Start's lazy chunks.
	const { default: handler } = await import("#start-handler");
	await clearDriveRuntimeLeases();
	await registerCrons(import.meta.path);
	const server = Bun.serve<RealtimeSession>({
		port: Number(process.env.PORT ?? 3000),
		hostname: process.env.HOST ?? "0.0.0.0",
		idleTimeout: 60,
		maxRequestBodySize: 65 * 1024 * 1024,
		routes: getAssetRoutes(),
		websocket: realtimeWebsocket,
		async fetch(request, server) {
			// Drive parts stream directly to disk; other upload endpoints keep the mail limit.
			if (
				!(
					/^\/api\/drive\/upload\/[^/]+$/.test(new URL(request.url).pathname) &&
					request.method === "PUT"
				) &&
				Number(request.headers.get("content-length")) > 30 * 1024 * 1024
			)
				return new Response("Request body too large", { status: 413 });
			if (new URL(request.url).pathname === "/api/realtime") {
				if (request.headers.get("origin") !== publicOrigin())
					return new Response("Invalid origin", { status: 403 });
				const token = sessionToken(request),
					user = await getUser(token);
				if (!token || !user)
					return new Response("Unauthorized", { status: 401 });
				if (server.upgrade(request, { data: { userId: user.id, token } }))
					return;
				return new Response("Expected WebSocket upgrade", { status: 426 });
			}
			if (isDriveUploadPath(new URL(request.url).pathname))
				return serveDriveUpload(request);
			return handler.fetch(request);
		},
	});
	console.log(`Mailrun listening on ${server.url}`);
	const shutdown = async () => {
		closeRealtimeConnections();
		const timeout = setTimeout(() => {
			void server.stop(true);
		}, 2000);
		await server.stop(false);
		clearTimeout(timeout);
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}
