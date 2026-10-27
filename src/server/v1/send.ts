import type { ApiPrincipal as User } from "../auth/key-principal";
import { sendEmailSchema } from "../../lib/validators";
import { deliveryPayloadSchema } from "../../shared/mail-contracts";
import { getEmailAddress } from "../../lib/email/address";
import {
	normalizeMessageId,
	parseMessageIdList,
} from "../../lib/email/threading";
import { buildSnippet } from "../../lib/email/parse";
import { withDatabase, id, seconds } from "../db";
import { adminWrite } from "../admin/accounts";
import { assertApiPrincipal } from "../auth/key-principal";
import { formattedSender, attachmentLimit } from "../mail/drafts";
import { upsertContact } from "../mail/contacts";
import { deliverJob } from "../mail/send";
import { LocalStorage, deleteUnreferencedObjects } from "../storage";
import type { CloudflareFetch } from "../cloudflare/client";
const recipients = (values: string[] | undefined) => {
	const seen = new Set<string>();
	return (values ?? []).filter((value) => {
		const email = getEmailAddress(value).toLowerCase();
		if (seen.has(email)) return false;
		seen.add(email);
		return true;
	});
};
export async function v1Send(
	user: User,
	value: unknown,
	request: CloudflareFetch = fetch,
) {
	const input = sendEmailSchema.parse(value);
	await withDatabase((sql) => assertApiPrincipal(sql, user, input.mailboxId));
	const from = await formattedSender(user, input.mailboxId, input.from),
		to = recipients(input.to),
		cc = recipients(input.cc),
		bcc = recipients(input.bcc),
		limit = await attachmentLimit();
	const payload = deliveryPayloadSchema.parse({
		from,
		to,
		cc,
		bcc,
		subject: input.subject,
		text: input.text,
		html: input.html,
		inReplyTo: normalizeMessageId(input.inReplyTo),
		references:
			parseMessageIdList(
				Array.isArray(input.references)
					? input.references.join(" ")
					: input.references,
			).join(" ") || null,
		threadId: input.threadId ?? null,
		returnToDraft: false,
	});
	const messageId = id("msg"),
		jobId = id("job"),
		storage = new LocalStorage(),
		written: string[] = [];
	const attachments: {
		id: string;
		key: string;
		filename: string;
		type: string;
		size: number;
	}[] = [];
	let committed = false,
		total = 0;
	try {
		for (const file of input.attachments ?? []) {
			const attachmentId = id("att"),
				key = `attachments/${messageId}/${attachmentId}`,
				filename =
					file.filename.trim().replace(/[/\\\0]/g, "_") || "attachment";
			const size = await publishAttachment(
				file,
				storage,
				key,
				Math.min(25_000_000, limit) - total,
				limit,
			);
			total += size;
			written.push(key);
			attachments.push({
				id: attachmentId,
				key,
				filename,
				type: file.type,
				size,
			});
			if (size >= 8_000_000) Bun.gc(true);
		}
		const scheduled =
			input.scheduledAt && Date.parse(input.scheduledAt) > Date.now()
				? Math.ceil(Date.parse(input.scheduledAt) / 1000)
				: null;
		await adminWrite(async (sql) => {
			await assertApiPrincipal(sql, user, input.mailboxId);
			await sql.NativeV1QueueMessage`INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,cc_addr,bcc_addr,subject,text_body,html_body,snippet,status,read,in_reply_to,references_header,thread_id,created_at) VALUES(${messageId},${user.id},${input.mailboxId},'outbound',${from},${to.join(", ")},${cc.length ? cc.join(", ") : null},${bcc.length ? bcc.join(", ") : null},${input.subject},${input.text ?? null},${input.html ?? null},${buildSnippet(input.text ?? null, input.html ?? null)},'queued',1,${payload.inReplyTo ?? null},${payload.references ?? null},${input.threadId ?? null},${seconds()})`;
			for (const file of attachments)
				await sql.NativeV1QueueAttachment`INSERT INTO message_attachments(id,message_id,filename,content_type,size,r2_key,disposition,created_at) VALUES(${file.id},${messageId},${file.filename},${file.type},${file.size},${file.key},'attachment',${seconds()})`;
			await sql.NativeV1QueueSend`INSERT INTO outbound_jobs(id,user_id,message_id,status,payload,created_at,updated_at,scheduled_at) VALUES(${jobId},${user.id},${messageId},'queued',${JSON.stringify(payload)},${seconds()},${seconds()},${scheduled})`;
		});
		committed = true;
		for (const address of [...to, ...cc, ...bcc])
			await upsertContact(user.id, address, "outbound").catch((error) =>
				console.error("API sent contact update failed", error),
			);
		if (scheduled) return { messageId, scheduled: true };
		await deliverJob(jobId, request);
		return { messageId };
	} finally {
		if (!committed) await deleteUnreferencedObjects(written);
	}
}

async function publishAttachment(
	file: NonNullable<
		ReturnType<typeof sendEmailSchema.parse>["attachments"]
	>[number],
	storage: LocalStorage,
	key: string,
	remaining: number,
	limit: number,
) {
	const text = file.contentBase64.replace(/\s/g, "");
	if (
		!/^[A-Za-z0-9+/]*={0,2}$/.test(text) ||
		text.length % 4 === 1 ||
		(text.includes("=") && text.length % 4 !== 0)
	)
		throw new Response("Invalid attachment encoding", { status: 400 });
	const bytes = Buffer.from(text, "base64");
	if (bytes.length > 25_000_000 || bytes.length > remaining)
		throw new Response(
			`Attachments exceed the administrator's ${limit / 1_000_000} MB outgoing limit`,
			{ status: 400 },
		);
	await storage.put(key, bytes);
	return bytes.length;
}
