import { isSetupPath, setupApi } from "../src/server/api/setup";
import { serveInbound } from "../src/server/mail/inbound";
import { startAvatarDispatcher } from "../src/server/avatars/dispatcher";
import { withSecurityHeaders } from "../src/server/http/security";
import {
	isProviderControlPath,
	serveProviderControl,
} from "../src/server/api/provider-session";
import { clearSendingStaging } from "../src/server/mail/sending-staging";
import { serveAgentChat } from "../src/server/api/agent-chat";
import { startAgentDispatcher } from "../src/server/agent/dispatcher";
import { handleMcpRequest } from "../src/server/mcp/handler";
import { isJmapPath, handleJmapRequest } from "../src/server/jmap/handler";
import { isV1Path, serveV1Api } from "../src/server/api/v1";
import { clearImapStaging } from "../src/server/mail-transfer/imap";
import {
	isMailTransferPath,
	serveMailTransfer,
} from "../src/server/api/mail-transfer";
import { startWebhookDispatcher } from "../src/server/webhooks/dispatcher";
import { clearDomainRuntimeLeases } from "../src/server/domains/repository";
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
import { serveWithSourceContract } from "../src/server/http/route-contract";

process.umask(0o077);
await migrate();
const name = cronJobFromArgs(process.argv);
if (name) {
	console.log(JSON.stringify({ job: name, ...(await runJob(name)) }));
} else {
	// Literal imports are bundled into the executable, including Start's lazy chunks.
	const { default: handler } = await import("#start-handler");
	await clearSendingStaging();
	await clearDriveRuntimeLeases();
	await clearImapStaging();
	await clearDomainRuntimeLeases();
	await registerCrons(import.meta.path);
	const stopWebhookDispatcher = startWebhookDispatcher();
	const stopAgentDispatcher = startAgentDispatcher();
	const stopAvatarDispatcher = startAvatarDispatcher();
	const server = Bun.serve<RealtimeSession>({
		port: Number(process.env.PORT ?? 3000),
		hostname: process.env.HOST ?? "0.0.0.0",
		idleTimeout: 60,
		maxRequestBodySize: 65 * 1024 * 1024,
		routes: getAssetRoutes(),
		websocket: realtimeWebsocket,
		async fetch(request, server) {
			const response = await serveWithSourceContract(
				request,
				async (request) => {
					// Drive parts stream directly to disk; other upload endpoints keep the mail limit.
					if (
						!(
							/^\/api\/drive\/upload\/[^/]+$/.test(
								new URL(request.url).pathname,
							) && request.method === "PUT"
						) &&
						Number(request.headers.get("content-length")) >
							(new URL(request.url).pathname === "/api/v1/send" ? 40 : 30) *
								1024 *
								1024
					)
						return Response.json(
							{ error: "Request body too large" },
							{ status: 413, headers: { "Cache-Control": "no-store" } },
						);
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
					if (
						new URL(request.url).pathname === "/api/inbound" &&
						request.method === "POST"
					)
						return serveInbound(request);
					if (isSetupPath(new URL(request.url).pathname)) {
						const setup = await setupApi(request, () =>
							server.timeout(request, 0),
						);
						if (setup) return setup;
					}
					if (isProviderControlPath(new URL(request.url).pathname))
						return serveProviderControl(request, () =>
							server.timeout(request, 0),
						);
					if (new URL(request.url).pathname === "/api/agent/chat")
						return serveAgentChat(request, () => server.timeout(request, 0));
					if (new URL(request.url).pathname === "/mcp")
						return handleMcpRequest(request, () => server.timeout(request, 0));
					if (isJmapPath(new URL(request.url).pathname)) {
						return handleJmapRequest(request, undefined, () =>
							server.timeout(request, 0),
						);
					}
					if (isDriveUploadPath(new URL(request.url).pathname))
						return serveDriveUpload(request);
					if (isV1Path(new URL(request.url).pathname)) {
						const response = await serveV1Api(request);
						// Release large JSON/request buffers after the HTTP handler has returned.
						if (Number(request.headers.get("content-length")) > 512 * 1024)
							setTimeout(() => Bun.gc(true), 0);
						return response;
					}
					if (isMailTransferPath(new URL(request.url).pathname)) {
						return serveMailTransfer(request, () => server.timeout(request, 0));
					}
					return handler.fetch(request);
				},
			);
			return response ? withSecurityHeaders(response) : undefined;
		},
	});
	console.log(`Mailrun listening on ${server.url}`);
	const shutdown = async () => {
		await stopAgentDispatcher();
		await stopAvatarDispatcher();
		await stopWebhookDispatcher();
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
