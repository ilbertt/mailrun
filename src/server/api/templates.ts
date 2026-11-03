import { z } from "zod";
import type { User } from "../../shared/contracts";
import { withDatabase, id, seconds } from "../db";
import { sourceSendSender } from "../mail/session-send";
import { deleteUnreferencedObjects } from "../storage";
import { buildSnippet } from "../../lib/email/parse";
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
					sql.NativeListTemplates`SELECT id,subject,html_body,text_body FROM messages WHERE user_id=${user.id} AND status='template' ORDER BY created_at DESC LIMIT 200`,
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
			const raw: unknown = await request.json().catch(() => null);
			const input = z
				.object({
					mailboxId: z.string().nullish(),
					from: z.string().optional(),
					title: z.string().optional(),
					html: z.string().nullish(),
					text: z.string().nullish(),
				})
				.nullable()
				.parse(raw);
			const title = input?.title?.trim().slice(0, 200),
				html = input?.html ?? "",
				text = input?.text ?? "";
			if (!title || !(html.trim() || text.trim()))
				throw new Response("Enter a title and content.", { status: 400 });
			if (!input?.mailboxId)
				throw new Response("Mailbox is required", { status: 403 });
			const mailboxId = input.mailboxId,
				templateId = id("msg");
			await withDatabase((sql) =>
				sql.begin(async (tx) => {
					await tx.NativeTemplateWriteFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
					const from = await sourceSendSender(
						user,
						mailboxId,
						input.from ?? "",
						tx,
					);
					await tx.NativeCreateTemplate`INSERT INTO messages (id,user_id,mailbox_id,direction,from_addr,to_addr,subject,snippet,text_body,html_body,status,read,created_at) VALUES (${templateId},${user.id},${mailboxId},'outbound',${from},'',${title},${buildSnippet(text, html)},${text || null},${html || null},'template',1,${seconds()})`;
				}),
			);
			return Response.json(
				{
					template: {
						id: templateId,
						subject: title,
						htmlBody: html || null,
						textBody: text || null,
					},
				},
				{ status: 201 },
			);
		}
	}
	const match = /^\/api\/templates\/([^/]+)$/.exec(path);
	if (match && method === "DELETE") {
		const templateId = decodeURIComponent(match[1] ?? "");
		const keys = await withDatabase((sql) =>
			sql.begin(async (tx) => {
				await tx.NativeTemplateDeleteFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
				const [row] =
					await tx.NativeTemplateObjects`SELECT raw_r2_key FROM messages WHERE id=${templateId} AND user_id=${user.id} AND status='template'`;
				if (!row) throw new Response("Template not found", { status: 404 });
				const files =
					await tx.NativeTemplateAttachments`SELECT r2_key FROM message_attachments WHERE message_id=${templateId}`;
				await tx.NativeDeleteTemplate`DELETE FROM messages WHERE id=${templateId} AND user_id=${user.id} AND status='template'`;
				return [
					...files.map((file) => file.r2_key),
					...(row.raw_r2_key ? [row.raw_r2_key] : []),
				];
			}),
		);
		await deleteUnreferencedObjects(keys);
		return Response.json({ ok: true });
	}
	return null;
}
