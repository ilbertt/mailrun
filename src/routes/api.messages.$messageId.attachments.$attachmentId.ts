import { createFileRoute } from "@tanstack/react-router";
import { downloadMessageFile } from "../server/mail/download";
export const Route = createFileRoute("/api/messages/$messageId/attachments/$attachmentId")({ server: { handlers: {
	GET: ({ params }) => downloadMessageFile(params.messageId, params.attachmentId),
} } });
