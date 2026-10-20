import { createFileRoute } from "@tanstack/react-router";
import { inbound } from "../server/mail/inbound";
export const Route = createFileRoute("/api/inbound")({ server: { handlers: { POST: ({ request }) => inbound(request) } } });
