import { createFileRoute } from "@tanstack/react-router";
import { serveMailApi } from "../server/api/mail";
const handle = ({ request }: { request: Request }) => serveMailApi(request);
export const Route = createFileRoute("/api/$")({
	server: {
		handlers: {
			GET: handle,
			POST: handle,
			PATCH: handle,
			PUT: handle,
			DELETE: handle,
		},
	},
});
