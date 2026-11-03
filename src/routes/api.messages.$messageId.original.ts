import { createFileRoute } from "@tanstack/react-router";
import { downloadMessageFile } from "../server/mail/download";
export const Route = createFileRoute("/api/messages/$messageId/original")({ server: { handlers: {
	GET: ({ params }) => downloadMessageFile(params.messageId),
} } });
