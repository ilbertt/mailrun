import type { AttachmentContent } from "../../lib/email/attachment-types";
import { parseRawMime, buildSnippet } from "../../lib/email/parse";
import {
	normalizeMessageId,
	selectThreadLookupIds,
} from "../../lib/email/thread-lookup";
import type { User } from "../../shared/contracts";
import type { ImportDestination } from "../../lib/import/destination-types";
import type {
	ImportMessageInput,
	ImportMailboxResult,
} from "../../lib/import/types";
import { splitMboxMessages } from "../../lib/import/mbox";
import { parseImportDestination } from "../../lib/import/destination";
import { withDatabase, id, seconds } from "../db";
import { LocalStorage, deleteUnreferencedObjects } from "../storage";
import { upsertContact } from "../mail/contacts";
import { readLimitedBody } from "../mail/inbound";
import { importContext, validateImport } from "./repository";
export async function parseImportUpload(request: Request) {
	const contentType = request.headers.get("content-type") ?? "";
	const bytes = await readLimitedBody(request, 25 * 1024 * 1024);
	const form = await new Response(bytes, {
		headers: { "Content-Type": contentType },
	}).formData();
	const mailboxId = String(form.get("mailboxId") ?? ""),
		destination = parseImportDestination(form.get("destination"));
	const files = form
		.getAll("files")
		.filter((file): file is File => file instanceof File && file.size > 0);
	const messages: ImportMessageInput[] = [];
	for (const file of files) {
		const name = file.name.toLowerCase();
		if (
			name.endsWith(".mbox") ||
			name.endsWith(".mbx") ||
			file.type === "application/mbox"
		) {
			for (const [index, raw] of splitMboxMessages(
				await file.text(),
			).entries()) {
				if (messages.length >= 100) break;
				messages.push({
					filename: `${file.name}#${index + 1}`,
					raw: new TextEncoder().encode(raw).buffer,
				});
			}
		} else if (
			name.endsWith(".eml") ||
			file.type === "message/rfc822" ||
			file.type === ""
		) {
			messages.push({ filename: file.name, raw: await file.arrayBuffer() });
		}
		if (messages.length >= 100) break;
	}
	if (!mailboxId || !messages.length)
		throw new Response("Select a mailbox and at least one .eml or .mbox file", {
			status: 400,
		});
	return { mailboxId, destination, messages };
}
export async function importMessages(
	user: User,
	mailboxId: string,
	destination: ImportDestination,
	messages: Iterable<ImportMessageInput> | AsyncIterable<ImportMessageInput>,
	signal?: AbortSignal,
): Promise<ImportMailboxResult> {
	await validateImport(user, mailboxId, destination);
	const result: ImportMailboxResult = { imported: 0, skipped: 0, errors: [] };
	for await (const message of messages) {
		if (signal?.aborted) throw new Error("Mail import cancelled");
		try {
			if (await importOneMessage(user, mailboxId, destination, message))
				result.imported++;
			else result.skipped++;
		} catch (error) {
			result.skipped++;
			result.errors.push(
				`${message.filename}: ${error instanceof Error ? error.message : error instanceof Response ? await error.text() : "Import failed"}`,
			);
		}
	}
	return result;
}
export async function importOneMessage(
	user: User,
	mailboxId: string,
	destination: ImportDestination,
	input: ImportMessageInput,
) {
	const parsed = await parseRawMime(input.raw),
		providerId =
			parsed.messageId ?? `import:${input.filename}:${input.raw.byteLength}`;
	const [existing] = await withDatabase(
		(sql) =>
			sql.NativeImportDuplicate`SELECT id FROM messages WHERE mailbox_id=${mailboxId} AND provider_message_id=${providerId} LIMIT 1`,
	);
	if (existing) return false;
	const messageId = id("msg"),
		storage = new LocalStorage(),
		rawKey = `imports/${messageId}.eml`,
		written: string[] = [];
	let committed = false;
	try {
		await storage.put(rawKey, input.raw);
		written.push(rawKey);
		const attachments: Array<AttachmentContent & { id: string; key: string }> =
			[];
		for (const attachment of parsed.attachments) {
			const attachmentId = id("att"),
				key = `attachments/${messageId}/${attachmentId}`;
			await storage.put(key, attachment.content);
			written.push(key);
			attachments.push({ id: attachmentId, key, ...attachment });
		}
		const variants = selectThreadLookupIds(
			parsed.inReplyTo,
			parsed.references,
		).flatMap((value) => [value, `<${value}>`]);
		const outcome = await withDatabase((sql) =>
			sql.begin(async (sql) => {
				await sql.NativeImportWriteFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
				const context = await importContext(sql, user, mailboxId, destination);
				const [duplicate] =
					await sql.NativeImportCommitDuplicate`SELECT id FROM messages WHERE mailbox_id=${mailboxId} AND provider_message_id=${providerId} LIMIT 1`;
				if (duplicate) return null;
				const [parent] = variants.length
					? await sql.NativeImportThread`SELECT thread_id,provider_message_id FROM messages WHERE mailbox_id=${mailboxId} AND provider_message_id IN(SELECT value FROM json_each(${JSON.stringify(variants)})) ORDER BY created_at,id LIMIT 1`
					: [];
				const placement = context.placement,
					threadId =
						parent?.thread_id ??
						normalizeMessageId(parent?.provider_message_id) ??
						normalizeMessageId(parsed.messageId) ??
						id("thr");
				await sql.NativeInsertImportedMessage`INSERT INTO messages(id,user_id,mailbox_id,folder_id,direction,provider_message_id,from_addr,to_addr,cc_addr,reply_to,subject,snippet,text_body,html_body,raw_r2_key,status,read,thread_id,in_reply_to,references_header,created_at) VALUES(${messageId},${context.userId},${mailboxId},${placement.folderId},${placement.direction},${providerId},${parsed.fromAddr ?? "unknown"},${parsed.toAddr ?? ""},${parsed.ccAddr},${parsed.replyTo},${parsed.subject},${buildSnippet(parsed.text, parsed.html)},${parsed.text},${parsed.html},${rawKey},${placement.status},${placement.direction === "outbound" ? 1 : 0},${threadId},${parsed.inReplyTo},${parsed.references.length ? parsed.references.join(" ") : null},${parsed.date ? Math.floor(parsed.date.getTime() / 1000) : seconds()})`;
				for (const attachment of attachments)
					await sql.NativeInsertImportedAttachment`INSERT INTO message_attachments(id,message_id,filename,content_type,size,disposition,content_id,r2_key,created_at) VALUES(${attachment.id},${messageId},${attachment.filename},${attachment.type},${attachment.content.byteLength},${attachment.disposition ?? "attachment"},${attachment.contentId ?? null},${attachment.key},${seconds()})`;
				return context;
			}),
		);
		if (!outcome) return false;
		committed = true;
		const address =
			outcome.placement.direction === "outbound"
				? parsed.toAddr
				: parsed.fromAddr;
		if (address)
			await upsertContact(
				outcome.userId,
				address,
				outcome.placement.direction,
				mailboxId,
			).catch((error) =>
				console.error("Imported contact update failed", error),
			);
		return true;
	} finally {
		if (!committed) await deleteUnreferencedObjects(written);
	}
}
