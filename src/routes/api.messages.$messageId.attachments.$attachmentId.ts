import { createFileRoute } from "@tanstack/react-router";
import { downloadMessageFile } from "../server/mail/download";
export const Route = createFileRoute(
	"/api/messages/$messageId/attachments/$attachmentId",
)({
	server: {
		handlers: {
			GET: ({ params, request }) =>
				downloadMessageFile(params.messageId, params.attachmentId, {
					preview:
						new URL(request.url).searchParams.get("preview") === "1" ||
						new URL(request.url).searchParams.get("inline") === "1",
					download: new URL(request.url).searchParams.get("download") === "1",
				}),
		},
	},
});
