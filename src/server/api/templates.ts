import { z } from "zod";
import type { User } from "../../shared/contracts";
import { withDatabase, id, seconds } from "../db";
import { formattedSender } from "../mail/drafts";
import { buildSnippet } from "../../lib/email/parse";
import { readLimitedBody } from "../mail/inbound";
export async function templatesApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	const path = new URL(request.url).pathname,
		method = request.method;
	if (path === "/api/templates") {
		if (method === "GET") {
			const rows = await withDatabase(
				(sql) =>
					sql.NativeListTemplates`SELECT id,subject,html_body,text_body FROM messages WHERE user_id=${user.id} AND status='template' ORDER BY created_at DESC,id DESC LIMIT 200`,
			);
			return Response.json({
				templates: rows.map((row) => ({
					id: row.id,
					subject: row.subject,
					htmlBody: row.html_body,
					textBody: row.text_body,
				})),
			});
		}
		if (method === "POST") {
			const input = z
				.object({
					mailboxId: z.string().min(1),
					from: z.string().max(500).optional(),
					title: z.string().trim().min(1).max(200),
					html: z.string().max(1_000_000).default(""),
					text: z.string().max(1_000_000).default(""),
				})
				.parse(
					JSON.parse(
						new TextDecoder().decode(await readLimitedBody(request, 2_100_000)),
					),
				);
			if (!input.html.trim() && !input.text.trim())
				throw new Response("Enter a title and content.", { status: 400 });
			const from = await formattedSender(user, input.mailboxId, input.from),
				templateId = id("msg");
			await withDatabase(
				(sql) =>
					sql.NativeCreateTemplate`INSERT INTO messages (id,user_id,mailbox_id,direction,from_addr,to_addr,subject,snippet,text_body,html_body,status,read,created_at) VALUES (${templateId},${user.id},${input.mailboxId},'outbound',${from},'',${input.title},${buildSnippet(input.text, input.html)},${input.text || null},${input.html || null},'template',1,${seconds()})`,
			);
			return Response.json(
				{
					template: {
						id: templateId,
						subject: input.title,
						htmlBody: input.html || null,
						textBody: input.text || null,
					},
				},
				{ status: 201 },
			);
		}
	}
	const match = /^\/api\/templates\/([^/]+)$/.exec(path);
	if (match && method === "DELETE") {
		const rows = await withDatabase(
			(sql) =>
				sql.NativeDeleteTemplate`DELETE FROM messages WHERE id=${decodeURIComponent(match[1] ?? "")} AND user_id=${user.id} AND status='template' RETURNING id`,
		);
		if (!rows.length) throw new Response("Template not found", { status: 404 });
		return Response.json({ ok: true });
	}
	return null;
}
