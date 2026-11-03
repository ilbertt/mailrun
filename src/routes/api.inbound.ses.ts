import { createFileRoute } from "@tanstack/react-router";
import { sesInbound } from "../server/aws/inbound";
export const Route = createFileRoute("/api/inbound/ses")({
	server: { handlers: { POST: ({ request }) => sesInbound(request) } },
});
