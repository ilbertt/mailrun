import { formatEmailAddress } from "../../lib/email/address";
import { resolveMailboxDisplayName } from "../../lib/profile/identity-utils";
import { z } from "zod";
import { withDatabase, seconds, id } from "../db";
import { mailboxAccess } from "./access";
import { draftSchema } from "../../shared/mail-contracts";
import type { User } from "../../shared/contracts";
import { deleteUnreferencedObjects, LocalStorage } from "../storage";
import { getThread } from "./repository";
import { normalizeLocalPart } from "./routing";
import { getEmailAddress } from "../../lib/email/address";

export async function draftLock<T>(draftId: string, run: () => Promise<T>) {
	const owner = id("lock");
	const name = `draft:${draftId}`;
	const [lock] = await withDatabase(
		(sql) => sql.ClaimDraftLock`
		INSERT INTO mailrun_job_leases (name,owner,expires_at) VALUES (${name},${owner},${seconds() + 180})
		ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
		WHERE mailrun_job_leases.expires_at<${seconds()} RETURNING owner`,
	);
	if (!lock)
		throw new Error("Draft is being saved in another request. Try again.");
	try {
		return await run();
	} finally {
		await withDatabase(
			(sql) =>
				sql.ReleaseDraftLock`DELETE FROM mailrun_job_leases WHERE name=${name} AND owner=${owner}`,
		);
	}
}
export async function senderAddress(
	user: User,
	mailboxId: string,
	requested?: string,
) {
	const mailbox = await mailboxAccess(user, mailboxId, "send");
	const primary = `${mailbox.local_part}@${mailbox.hostname}`;
	const address = getEmailAddress(requested ?? primary).toLowerCase();
	if (address === primary.toLowerCase()) return primary;
	const aliases = await withDatabase(
		(sql) =>
			sql.SenderAliases`SELECT a.local_part,d.hostname FROM mailbox_aliases a JOIN domains d ON d.id=a.domain_id WHERE a.mailbox_id=${mailboxId}`,
	);
	if (
		aliases.some((alias) => `${alias.local_part}@${alias.hostname}` === address)
	)
		return address;
	if (mailbox.use_all_domains) {
		const [domain] = await withDatabase(
			(sql) =>
				sql.SenderDomainAlias`SELECT id FROM domains WHERE hostname=${address.split("@")[1] ?? ""} AND user_id=${mailbox.domain_owner} AND status='active'`,
		);
		if (
			domain &&
			normalizeLocalPart(address.split("@")[0] ?? "") ===
				normalizeLocalPart(mailbox.local_part)
		) {
			const local = normalizeLocalPart(mailbox.local_part);
			const occupied = await withDatabase(
				(sql) => sql.SenderAddressOccupied`
				SELECT id FROM mailboxes WHERE domain_id=${domain.id} AND id!=${mailboxId} AND replace(lower(substr(local_part,1,instr(local_part||'+','+')-1)),'.','')=${local}
				UNION ALL SELECT id FROM mailbox_aliases WHERE domain_id=${domain.id} AND mailbox_id!=${mailboxId} AND replace(lower(substr(local_part,1,instr(local_part||'+','+')-1)),'.','')=${local} LIMIT 1`,
			);
			if (!occupied.length) return address;
		}
	}
	throw new Error("Sender address is not assigned to this mailbox");
}
export async function formattedSender(
	user: User,
	mailboxId: string,
	requested?: string,
) {
	const address = await senderAddress(user, mailboxId, requested),
		mailbox = await mailboxAccess(user, mailboxId, "send");
	const name = resolveMailboxDisplayName(
		{
			localPart: mailbox.local_part,
			hostname: mailbox.hostname,
			type: mailbox.type,
			displayName: mailbox.display_name,
		},
		mailbox.owner_email,
		mailbox.owner_name,
	);
	return formatEmailAddress(
		address,
		mailbox.permission === "send_on_behalf"
			? `${user.name} on behalf of ${name || address}`
			: name,
	);
}
export async function getDraft(user: User, draftId: string) {
	const [draft] = await withDatabase(
		(sql) =>
			sql.OwnDraft`SELECT * FROM messages WHERE id=${draftId} AND user_id=${user.id} AND status='draft' AND direction='outbound'`,
	);
	if (!draft) throw new Error("Draft not found");
	const attachments = await withDatabase(
		(sql) =>
			sql.DraftAttachments`SELECT id,message_id,filename,content_type,size,r2_key,disposition,content_id FROM message_attachments WHERE message_id=${draft.id} AND trashed_at IS NULL ORDER BY created_at,id`,
	);
	return { ...draft, mailbox_id: draft.mailbox_id, attachments };
}
export async function attachmentLimit() {
	const [settings] = await withDatabase(
		(sql) =>
			sql.OutgoingAttachmentLimit`SELECT outbound_attachment_max_mb FROM app_settings WHERE id='default'`,
	);
	return (settings?.outbound_attachment_max_mb ?? 25) * 1_000_000;
}
export async function saveDraft(
	user: User,
	input: z.infer<typeof draftSchema>,
) {
	const data = draftSchema.parse(input);
	const from = await formattedSender(user, data.mailboxId, data.from);
	const draftId = data.id ?? id("msg");
	return draftLock(draftId, async () => {
		if (data.id) {
			const current = await getDraft(user, draftId);
			if (data.revision !== current.draft_revision)
				throw new Error(
					"This draft changed in another tab. Reopen it before saving.",
				);
			const updated = await withDatabase((sql) =>
				sql.begin(async (sql) => {
					const updated = await sql.UpdateDraft`
				UPDATE messages SET mailbox_id=${data.mailboxId},from_addr=${from},to_addr=${data.to},cc_addr=${data.cc || null},bcc_addr=${data.bcc || null},subject=${data.subject},text_body=${data.text},html_body=${data.html},snippet=${data.text.slice(0, 200)},draft_revision=draft_revision+1,draft_scheduled_at=${data.scheduledAt ? Math.floor(Date.parse(data.scheduledAt) / 1000) : null}
				WHERE id=${draftId} AND user_id=${user.id} AND status='draft' AND draft_revision=${data.revision} RETURNING id`;
					if (updated.length)
						await sql.NativeHumanAgentDraftSave`UPDATE agent_draft_metadata SET revision=revision+1,human_edited_at=${seconds()},scheduled_at=${data.scheduledAt ? Math.floor(Date.parse(data.scheduledAt) / 1000) : null} WHERE draft_id=${draftId}`;
					return updated;
				}),
			);
			if (!updated.length)
				throw new Error("Draft was changed or sent in another request");
		} else {
			if (data.forwardOfMessageId)
				await getThread(user, data.forwardOfMessageId);
			await withDatabase(
				(sql) => sql.CreateDraft`
				INSERT INTO messages (id,user_id,mailbox_id,direction,from_addr,to_addr,cc_addr,bcc_addr,subject,text_body,html_body,snippet,status,read,in_reply_to,references_header,thread_id,draft_scheduled_at,created_at)
				VALUES (${draftId},${user.id},${data.mailboxId},'outbound',${from},${data.to},${data.cc || null},${data.bcc || null},${data.subject},${data.text},${data.html},${data.text.slice(0, 200)},'draft',1,${data.inReplyTo ?? null},${data.references ?? null},${data.threadId ?? null},${data.scheduledAt ? Math.floor(Date.parse(data.scheduledAt) / 1000) : null},${seconds()})`,
			);
			if (data.forwardOfMessageId) {
				try {
					await copyAttachments(data.forwardOfMessageId, draftId);
				} catch (error) {
					await withDatabase(
						(sql) =>
							sql.RollbackNewDraft`DELETE FROM messages WHERE id=${draftId}`,
					);
					throw error;
				}
			}
		}
		return getDraft(user, draftId);
	});
}
async function copyAttachments(sourceId: string, draftId: string) {
	const attachments = await withDatabase(
		(sql) =>
			sql.ForwardAttachments`SELECT filename,content_type,size,r2_key,content_id,disposition FROM message_attachments WHERE message_id=${sourceId} AND trashed_at IS NULL`,
	);
	if (
		attachments.length > 10 ||
		attachments.reduce((total, file) => total + file.size, 0) >
			(await attachmentLimit())
	)
		throw new Error("Attachments exceed the count or size limit");
	const storage = new LocalStorage();
	const created: string[] = [];
	try {
		for (const attachment of attachments) {
			const key = `attachments/${draftId}/${id("file")}`;
			await storage.put(key, await storage.file(attachment.r2_key).bytes());
			created.push(key);
			await withDatabase(
				(sql) => sql.CopyForwardAttachment`
				INSERT INTO message_attachments (id,message_id,filename,content_type,size,r2_key,content_id,disposition,created_at)
				VALUES (${id("att")},${draftId},${attachment.filename},${attachment.content_type},${attachment.size},${key},${attachment.content_id},${attachment.disposition},${seconds()})`,
			);
		}
	} catch (error) {
		await Promise.all(created.map((key) => storage.delete(key)));
		throw error;
	}
}
export async function uploadAttachments(
	user: User,
	draftId: string,
	files: File[],
	expectedRevision?: number,
) {
	return draftLock(draftId, async () => {
		const draft = await getDraft(user, draftId);
		if (
			expectedRevision !== undefined &&
			draft.draft_revision !== expectedRevision
		)
			throw new Error(
				"This draft changed in another tab. Reopen it before saving.",
			);
		const limit = await attachmentLimit();
		if (
			!files.length ||
			draft.attachments.length + files.length > 10 ||
			files.some((file) => !file.size || file.size > limit) ||
			draft.attachments.reduce(
				(total, attachment) => total + attachment.size,
				0,
			) +
				files.reduce((total, file) => total + file.size, 0) >
				limit
		)
			throw new Error("Attachments exceed the count or size limit");
		const storage = new LocalStorage();
		const uploaded: string[] = [];
		try {
			const entries: {
				key: string;
				name: string;
				type: string;
				size: number;
			}[] = [];
			for (const file of files) {
				const key = `attachments/${draftId}/${id("file")}`;
				await storage.put(key, await file.bytes());
				uploaded.push(key);
				entries.push({
					key,
					name: file.name.slice(0, 255),
					type: file.type || "application/octet-stream",
					size: file.size,
				});
			}
			await withDatabase((sql) =>
				sql.begin(async (sql) => {
					const claimed =
						await sql.TouchDraftUpload`UPDATE messages SET draft_revision=draft_revision+1 WHERE id=${draftId} AND user_id=${user.id} AND status='draft' RETURNING id`;
					if (!claimed.length) throw new Error("Draft is no longer editable");
					await sql.NativeHumanAgentAttachmentAdd`UPDATE agent_draft_metadata SET revision=revision+1,human_edited_at=${seconds()} WHERE draft_id=${draftId}`;
					for (const entry of entries)
						await sql.UploadDraftAttachment`
					INSERT INTO message_attachments (id,message_id,filename,content_type,size,r2_key,created_at)
					VALUES (${id("att")},${draftId},${entry.name},${entry.type},${entry.size},${entry.key},${seconds()})`;
				}),
			);
		} catch (error) {
			await Promise.all(uploaded.map((key) => storage.delete(key)));
			throw error;
		}
		return getDraft(user, draftId);
	});
}
export async function removeAttachment(
	user: User,
	draftId: string,
	attachmentId: string,
	expectedRevision?: number,
) {
	return draftLock(draftId, async () => {
		const draft = await getDraft(user, draftId);
		if (
			expectedRevision !== undefined &&
			draft.draft_revision !== expectedRevision
		)
			throw new Error(
				"This draft changed in another tab. Reopen it before saving.",
			);
		const attachment = draft.attachments.find(
			(attachment) => attachment.id === attachmentId,
		);
		if (!attachment) throw new Error("Attachment not found");
		await withDatabase((sql) =>
			sql.begin(async (sql) => {
				await sql.RemoveDraftAttachment`DELETE FROM message_attachments WHERE id=${attachmentId} AND message_id=${draftId}`;
				await sql.TouchDraftRemoval`UPDATE messages SET draft_revision=draft_revision+1 WHERE id=${draftId} AND status='draft'`;
				await sql.NativeHumanAgentAttachmentRemove`UPDATE agent_draft_metadata SET revision=revision+1,human_edited_at=${seconds()} WHERE draft_id=${draftId}`;
			}),
		);
		await deleteUnreferencedObjects([attachment.r2_key]);
		return getDraft(user, draftId);
	});
}
export async function deleteDraft(
	user: User,
	draftId: string,
	expectedRevision?: number,
) {
	return draftLock(draftId, async () => {
		const draft = await getDraft(user, draftId);
		if (
			expectedRevision !== undefined &&
			draft.draft_revision !== expectedRevision
		)
			throw new Error(
				"This draft changed in another tab. Reopen it before saving.",
			);
		await withDatabase(
			(sql) =>
				sql.DeleteOwnedDraft`DELETE FROM messages WHERE id=${draftId} AND user_id=${user.id} AND status='draft'`,
		);
		await deleteUnreferencedObjects([
			...draft.attachments.map((attachment) => attachment.r2_key),
			...(draft.raw_r2_key ? [draft.raw_r2_key] : []),
		]);
	});
}
