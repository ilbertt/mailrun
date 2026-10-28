import { withDatabase, id, seconds } from "../db";
import { LocalStorage } from "../storage";
import { publicOrigin } from "../config";
import type { OutboundAttachment } from "./provider";
const escapeHtml = (value: string) =>
	value.replace(
		/[&<>"']/g,
		(char) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				char
			] ?? char,
	);
export async function prepareAttachments(
	messageId: string,
	message: {
		subject: string;
		text?: string;
		html?: string;
		headers: Record<string, string>;
	},
	provider: "cloudflare" | "resend" = "cloudflare",
) {
	const rows = await withDatabase(
		(sql) =>
			sql.SendingAttachments`SELECT id,filename,content_type,size,r2_key,disposition,content_id FROM message_attachments WHERE message_id=${messageId} AND trashed_at IS NULL ORDER BY created_at,id`,
	);
	if (provider !== "cloudflare") {
		const attachments: OutboundAttachment[] = [];
		for (const row of rows) {
			const content = new LocalStorage().file(row.r2_key);
			if (!(await content.exists()))
				throw new Error("Attachment file not found");
			attachments.push({
				filename: row.filename,
				type: row.content_type,
				content,
				disposition: row.disposition,
				...(row.content_id ? { contentId: row.content_id } : {}),
			});
		}
		return { attachments, text: message.text, html: message.html };
	}

	const attachments: OutboundAttachment[] = [];
	const linked: Array<{ filename: string; size: number; url: string }> = [];
	let size =
		Buffer.byteLength(
			message.subject +
				(message.text ?? "") +
				(message.html ?? "") +
				JSON.stringify(message.headers),
		) + 8192;
	const max = 5 * 1024 * 1024 - 256 * 1024;
	for (const row of rows) {
		const encoded = Math.ceil(row.size / 3) * 4 + 2048;
		if (row.size <= 3_000_000 && size + encoded <= max) {
			const content = Buffer.from(
				await new LocalStorage().file(row.r2_key).arrayBuffer(),
			).toString("base64");
			attachments.push({
				filename: row.filename,
				type: row.content_type,
				content,
				disposition: row.disposition,
				...(row.content_id ? { contentId: row.content_id } : {}),
			});
			size += encoded;
		} else {
			await withDatabase(
				(sql) =>
					sql.ExpiredAttachmentLink`DELETE FROM shared_attachment_links WHERE attachment_id=${row.id} AND expires_at<=${seconds()}`,
			);
			await withDatabase(
				(sql) =>
					sql.CreateAttachmentLink`INSERT INTO shared_attachment_links (id,attachment_id,expires_at,created_at) VALUES (${id("share")},${row.id},${seconds() + 30 * 86400},${seconds()}) ON CONFLICT(attachment_id) DO NOTHING`,
			);
			const [link] = await withDatabase(
				(sql) =>
					sql.GetAttachmentLink`SELECT id FROM shared_attachment_links WHERE attachment_id=${row.id}`,
			);
			if (!link) throw new Error("Could not share attachment");
			linked.push({
				filename: row.filename,
				size: row.size,
				url: `${publicOrigin()}/api/shared-files/${encodeURIComponent(link.id)}`,
			});
		}
	}
	const intro =
		"Files shared through Mailflare (download links expire after 30 days):";
	const textLinks = linked
		.map(
			(file) =>
				`${file.filename} (${(file.size / 1_000_000).toFixed(1)} MB): ${file.url}`,
		)
		.join("\n");
	const htmlLinks = linked
		.map(
			(file) =>
				`<li>${escapeHtml(file.filename)} (${(file.size / 1_000_000).toFixed(1)} MB): <a href="${escapeHtml(file.url)}">Download file</a></li>`,
		)
		.join("");
	const text = linked.length
		? [message.text?.trim(), intro, textLinks].filter(Boolean).join("\n\n")
		: message.text;
	const html = linked.length
		? `${message.html ?? ""}<div><p>${escapeHtml(intro)}</p><ul>${htmlLinks}</ul></div>`
		: message.html;
	if (
		size +
			(linked.length
				? Buffer.byteLength(textLinks + htmlLinks + intro + intro) + 4096
				: 0) >
		max
	)
		throw new Error(
			linked.length
				? "Message exceeds Cloudflare's 5 MiB email size limit even with download links"
				: "Message exceeds Cloudflare's 5 MiB email size limit",
		);
	return { attachments, text, html };
}
export async function sharedFile(token: string) {
	const [row] = await withDatabase(
		(sql) => sql.PublicAttachment`
		SELECT a.r2_key,a.filename,a.content_type FROM shared_attachment_links l JOIN message_attachments a ON a.id=l.attachment_id
		WHERE l.id=${token} AND l.expires_at>${seconds()} AND a.trashed_at IS NULL LIMIT 1`,
	);
	if (!row)
		return new Response("Link expired or file not found", { status: 404 });
	const file = new LocalStorage().file(row.r2_key);
	if (!(await file.exists()))
		return new Response("File not found", { status: 404 });
	return new Response(file, {
		headers: {
			"Content-Type": row.content_type,
			"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}
