import { createFileRoute } from "@tanstack/react-router";
import { getInstallation } from "../server/cloudflare/installation";
import { verifyRelay } from "../shared/relay-signature";
export const Route = createFileRoute("/api/relay-health")({ server: { handlers: { POST: async ({ request }) => {
	const installation = await getInstallation();
	if (!installation) return new Response("Not configured", { status: 503 });
	const valid = await verifyRelay(installation.relay_secret, request.headers.get("x-mailrun-timestamp") ?? "", "", "", new Uint8Array(), request.headers.get("x-mailrun-signature") ?? "");
	return valid ? Response.json({ ok: true }) : new Response("Unauthorized", { status: 401 });
} } } });
