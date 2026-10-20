import PostalMime from "postal-mime";
import { withDatabase, id, seconds } from "../db";
import { LocalStorage } from "../storage";
import { getInstallation } from "../cloudflare/installation";
import { verifyRelay } from "../../shared/relay-signature";
import { relayDecisionSchema } from "../../shared/contracts";

export async function readLimitedBody(request: Request, limit: number) {
	if (Number(request.headers.get("content-length") ?? 0) > limit) throw new Error("Message too large");
	const chunks: Uint8Array[] = [];
	let length = 0;
	const reader = request.body?.getReader();
	if (reader) {
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				length += chunk.value.length;
				if (length > limit) { await reader.cancel(); throw new Error("Message too large"); }
				chunks.push(chunk.value);
			}
		} finally { reader.releaseLock(); }
	}
	const bytes = new Uint8Array(length);
	let position = 0;
	for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
	return bytes;
}

export async function inbound(request: Request): Promise<Response> {
	const installation = await getInstallation();
	if (!installation) return new Response("Email not configured", { status: 503 });
	let raw: Uint8Array<ArrayBuffer>;
	try { raw = await readLimitedBody(request, 25 * 1024 * 1024); }
	catch (error) {
		if (error instanceof Error && error.message === "Message too large") return new Response(error.message, { status: 413 });
		throw error;
	}
	const from = request.headers.get("x-mailrun-from") ?? "";
	const to = request.headers.get("x-mailrun-to") ?? "";
	const valid = await verifyRelay(installation.relay_secret, request.headers.get("x-mailrun-timestamp") ?? "", from, to, raw, request.headers.get("x-mailrun-signature") ?? "");
	if (!valid) return new Response("Invalid signature", { status: 401 });
	const result = await storeInbound(from, to, raw);
	return Response.json(relayDecisionSchema.parse(result));
}

export async function storeInbound(from: string, to: string, raw: Uint8Array<ArrayBuffer>) {
	to = to.toLowerCase();
	const at = to.lastIndexOf("@");
	const localPart = to.slice(0, at);
	const hostname = to.slice(at + 1);
	const mailbox = await withDatabase(async sql => (await sql.InboundMailbox`
		/* @notNull id */
		/* @notNull user_id */
		SELECT m.id,m.user_id FROM mailboxes m JOIN domains d ON d.id=m.domain_id
		WHERE d.hostname=${hostname} AND m.local_part=${localPart} AND m.disabled=0 LIMIT 1`)[0]);
	if (!mailbox) return { action: "reject" as const, reason: "Unknown recipient" };
	const digest = new Bun.CryptoHasher("sha256").update(to).update("\n").update(raw).digest("hex");
	const messageId = `msg_${digest}`;
	const rawKey = `inbound/${digest}.eml`;
	const exists = await withDatabase(sql => sql.InboundExists`SELECT id FROM messages WHERE id=${messageId}`);
	if (exists.length) return { action: "store" as const, messageId };
	const parsed = await PostalMime.parse(raw);
	if (parsed.attachments.length > 10) return { action: "reject" as const, reason: "Message exceeds the 10-attachment receiving limit" };
	const storage = new LocalStorage();
	await storage.put(rawKey, raw);
	const attachments = await Promise.all(parsed.attachments.map(async (attachment, index) => {
		const key = `attachments/${digest}/${index}`;
		const bytes = typeof attachment.content === "string" ? new TextEncoder().encode(attachment.content) : new Uint8Array(attachment.content);
		await storage.put(key, bytes);
		return { key, filename: attachment.filename ?? "attachment", contentType: attachment.mimeType, size: bytes.length, contentId: attachment.contentId ?? null, disposition: attachment.disposition ?? "attachment" };
	}));
	const reference = parsed.inReplyTo?.replace(/^<|>$/g, "") ?? "";
	const parent = await withDatabase(async sql => (await sql.InboundParent`
			SELECT thread_id,id FROM messages WHERE mailbox_id=${mailbox.id}
			AND (provider_message_id=${reference} OR provider_message_id=${`<${reference}>`}) LIMIT 1`)[0]);
	// The transaction begins with a write. Concurrent duplicate deliveries cannot
	// get stuck upgrading two deferred read transactions to write transactions.
	await withDatabase(sql => sql.begin(async sql => {
		const inserted = await sql.InsertInbound`
			INSERT INTO messages (id,user_id,mailbox_id,direction,provider_message_id,from_addr,to_addr,subject,snippet,text_body,html_body,raw_r2_key,status,thread_id,in_reply_to,created_at)
			VALUES (${messageId},${mailbox.user_id},${mailbox.id},'inbound',${parsed.messageId ?? null},${from},${to},${parsed.subject ?? ""},${(parsed.text ?? "").slice(0, 200)},${parsed.text ?? null},${parsed.html ?? null},${rawKey},'received',${parent?.thread_id ?? parent?.id ?? messageId},${reference || null},${seconds()})
			ON CONFLICT(id) DO NOTHING RETURNING id`;
		if (!inserted.length) return;
		for (const attachment of attachments) {
			await sql.InsertInboundAttachment`
				INSERT INTO message_attachments (id,message_id,filename,content_type,size,disposition,content_id,r2_key,created_at)
				VALUES (${id("att")},${messageId},${attachment.filename},${attachment.contentType},${attachment.size},${attachment.disposition},${attachment.contentId},${attachment.key},${seconds()})`;
		}
	}));
	return { action: "store" as const, messageId };
}
