import { z } from "zod";
import { withDatabase } from "../db";
import { readLimitedBody } from "../mail/inbound";
import {
	requestAgentSend,
	getAgentSendRequest,
	confirmAgentSend,
} from "../agent/approvals";
import type { User } from "../../shared/contracts";
import type { CloudflareFetch } from "../cloudflare/client";
const schema = z.object({
	draftId: z.string().min(1),
	expectedRevision: z.number().int().positive(),
});
export async function agentApprovalsApi(
	request: Request,
	user: User,
	send: CloudflareFetch = fetch,
): Promise<Response | null> {
	const path = new URL(request.url).pathname,
		method = request.method;
	if (method === "POST" && path === "/api/agent/approvals") {
		const parsed = schema.safeParse(
			JSON.parse(
				new TextDecoder().decode(await readLimitedBody(request, 32 * 1024)),
			),
		);
		if (!parsed.success)
			return Response.json({ error: "Invalid request" }, { status: 400 });
		try {
			const [row] = await withDatabase(
				(sql) =>
					sql.NativeAgentApprovalMailbox`SELECT mailbox_id FROM messages WHERE id=${parsed.data.draftId} AND user_id=${user.id} AND status='draft'`,
			);
			if (!row?.mailbox_id) throw new Error("Draft not found");
			return Response.json(
				await requestAgentSend(
					{ user, mailboxId: row.mailbox_id, origin: "chat" },
					parsed.data.draftId,
					parsed.data.expectedRevision,
				),
			);
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Could not create approval",
				},
				{ status: 409 },
			);
		}
	}
	const match = /^\/api\/agent\/approvals\/([^/]+)(\/confirm)?$/.exec(path);
	if (!match) return null;
	const id = decodeURIComponent(match[1]!);
	if (method === "GET" && !match[2]) {
		try {
			return Response.json(await getAgentSendRequest(user, id), {
				headers: { "Cache-Control": "no-store" },
			});
		} catch {
			return Response.json({ error: "Approval not found" }, { status: 404 });
		}
	}
	if (method === "POST" && match[2]) {
		try {
			return Response.json(await confirmAgentSend(user, id, send));
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Send could not be confirmed",
				},
				{ status: 409 },
			);
		}
	}
	return null;
}
