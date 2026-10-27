import { createFileRoute } from "@tanstack/react-router";
import { handleJmapRequest } from "../server/jmap/handler";
const handle = ({ request }: { request: Request }) =>
	handleJmapRequest(request);
export const Route = createFileRoute("/.well-known/jmap")({
	server: {
		handlers: { GET: handle, HEAD: handle, POST: handle, OPTIONS: handle },
	},
});
