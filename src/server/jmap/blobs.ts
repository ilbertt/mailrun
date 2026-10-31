import { withDatabase, id, seconds } from "../db";
import { LocalStorage, deleteUnreferencedObjects } from "../storage";
import { assertApiPrincipal } from "../auth/key-principal";
import { LIMITS } from "./constants";
import { decodeBlobId, uploadBlobId } from "./ids";
import { loadMessages, jmapAttachments } from "./repository";
import type { JmapContext } from "./types";
export const uploadKey = (ctx: JmapContext, uploadId: string) =>
	`jmap-uploads/${ctx.auth.userId}/${uploadId}`;
export async function storeUpload(
	ctx: JmapContext,
	body: ArrayBuffer,
	type: string,
	name: string | null,
) {
	if (body.byteLength > LIMITS.maxSizeUpload) return null;
	const uploadId = id("upl"),
		key = uploadKey(ctx, uploadId),
		storage = new LocalStorage();
	let committed = false;
	try {
		await storage.put(key, body);
		await withDatabase((sql) =>
			sql.begin(async (sql) => {
				await sql.NativeJmapUploadFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
				await assertApiPrincipal(sql, ctx.actor);
				await sql.NativeJmapCreateUpload`INSERT INTO mailrun_jmap_uploads(id,user_id,r2_key,content_type,name,size,created_at) VALUES(${uploadId},${ctx.auth.userId},${key},${type},${name},${body.byteLength},${seconds()})`;
			}),
		);
		committed = true;
		return {
			accountId: ctx.accountId,
			blobId: uploadBlobId(uploadId),
			type,
			size: body.byteLength,
		};
	} finally {
		if (!committed) await storage.delete(key);
	}
}
export async function readUpload(ctx: JmapContext, uploadId: string) {
	const [row] = await withDatabase(
		(sql) =>
			sql.NativeJmapReadUpload`SELECT r2_key,content_type,name FROM mailrun_jmap_uploads WHERE id=${uploadId} AND user_id=${ctx.auth.userId}`,
	);
	if (!row) return null;
	const file = new LocalStorage().file(row.r2_key);
	if (!(await file.exists())) return null;
	return {
		content: await file.arrayBuffer(),
		type: row.content_type,
		name: row.name,
	};
}
export async function deleteUpload(ctx: JmapContext, uploadId: string) {
	const rows = await withDatabase(
		(sql) =>
			sql.NativeJmapDeleteUpload`DELETE FROM mailrun_jmap_uploads WHERE id=${uploadId} AND user_id=${ctx.auth.userId} RETURNING r2_key`,
	);
	await deleteUnreferencedObjects(rows.map((row) => row.r2_key));
}
export async function readBlob(
	ctx: JmapContext,
	blobId: string,
): Promise<{
	body: Blob | ArrayBuffer;
	type: string;
	name: string | null;
	size: number;
} | null> {
	const ref = decodeBlobId(blobId);
	if (!ref) return null;
	if (ref.kind === "up") {
		const [row] = await withDatabase(
			(sql) =>
				sql.NativeJmapUploadBlob`SELECT * FROM mailrun_jmap_uploads WHERE id=${ref.id} AND user_id=${ctx.auth.userId}`,
		);
		if (!row) return null;
		const file = new LocalStorage().file(row.r2_key);
		return (await file.exists())
			? { body: file, type: row.content_type, name: row.name, size: row.size }
			: null;
	}
	if (ref.kind === "att") {
		const [file] = await withDatabase(
			(sql) =>
				sql.NativeJmapAttachmentBlob`SELECT message_id,r2_key,filename,content_type,size FROM message_attachments WHERE id=${ref.id} AND trashed_at IS NULL`,
		);
		if (!file || (await loadMessages(ctx, [file.message_id])).length === 0)
			return null;
		const body = new LocalStorage().file(file.r2_key);
		return (await body.exists())
			? { body, type: file.content_type, name: file.filename, size: file.size }
			: null;
	}
	const [row] = await loadMessages(ctx, [ref.id]);
	if (!row || !row.mailboxId) return null;
	if (row.rawR2Key) {
		const file = new LocalStorage().file(row.rawR2Key);
		if (await file.exists())
			return {
				body: file,
				type: "message/rfc822",
				name: `${row.id}.eml`,
				size: file.size,
			};
	}
	const safe = (value: string) => value.replace(/[\r\n]/g, " ");
	const lines = [
		`From: ${safe(row.fromAddr)}`,
		`To: ${safe(row.toAddr)}`,
		...(row.ccAddr ? [`Cc: ${safe(row.ccAddr)}`] : []),
		`Subject: ${safe(row.subject ?? "")}`,
		`Date: ${row.createdAt.toUTCString()}`,
		...(row.providerMessageId
			? [`Message-ID: ${safe(row.providerMessageId)}`]
			: []),
		...(row.inReplyTo ? [`In-Reply-To: <${safe(row.inReplyTo)}>`] : []),
		"MIME-Version: 1.0",
		`Content-Type: ${row.htmlBody ? "text/html" : "text/plain"}; charset=utf-8`,
		"",
		row.htmlBody ?? row.textBody ?? "",
	];
	const body = new TextEncoder().encode(lines.join("\r\n")).buffer;
	return {
		body,
		type: "message/rfc822",
		name: `${row.id}.eml`,
		size: body.byteLength,
	};
}
