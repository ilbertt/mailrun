import { createFileRoute } from "@tanstack/react-router";
import { handleMcpRequest } from "../server/mcp/handler";
const handle = ({ request }: { request: Request }) => handleMcpRequest(request);
export const Route = createFileRoute("/mcp")({
	server: {
		handlers: {
			GET: handle,
			HEAD: handle,
			POST: handle,
			DELETE: handle,
			OPTIONS: handle,
		},
	},
});
