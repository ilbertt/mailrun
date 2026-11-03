import { createFileRoute } from "@tanstack/react-router";
import { withDatabase } from "../server/db";
export const Route = createFileRoute("/api/health")({ server: { handlers: { GET: async () => {
	await withDatabase(sql => sql`SELECT 1`);
	return Response.json({ ok: true, app: "mailrun" });
} } } });
