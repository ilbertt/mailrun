import { createFileRoute } from "@tanstack/react-router";
import { sharedFile } from "../server/mail/attachment-send";
export const Route = createFileRoute("/api/shared-files/$token")({
	server: { handlers: { GET: ({ params }) => sharedFile(params.token) } },
});
