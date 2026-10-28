import { createFileRoute } from "@tanstack/react-router";
import { resendInbound } from "../server/resend/inbound";
export const Route = createFileRoute("/api/inbound/resend")({
	server: { handlers: { POST: ({ request }) => resendInbound(request) } },
});
