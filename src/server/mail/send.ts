import { z } from "zod";
import { sendSchema, type User } from "../../shared/contracts";
import { withDatabase, id, seconds } from "../db";
import { getInstallation } from "../cloudflare/installation";
import { cloudflare } from "../cloudflare/client";

const storedSendSchema = z.object({
	from: z.email(), to: z.union([z.email(), z.array(z.string())]), subject: z.string(),
	text: z.string().optional(), html: z.string().optional(),
	cc: z.array(z.string()).optional(), bcc: z.array(z.string()).optional(),
});
export async function sendMessage(user: User, input: z.infer<typeof sendSchema>) {
	const data = sendSchema.parse(input);
	const mailbox = await withDatabase(async sql => (await sql.SendingMailbox`
		SELECT b.local_part,d.hostname FROM mailboxes b JOIN domains d ON d.id=b.domain_id
		WHERE b.id=${data.mailboxId} AND b.disabled=0 AND d.sending_enabled=1
		AND (b.user_id=${user.id} OR d.user_id=${user.id}
			OR EXISTS (SELECT 1 FROM mailbox_access a WHERE a.mailbox_id=b.id AND a.user_id=${user.id} AND a.permission IN ('full_access','send_as','send_on_behalf'))) LIMIT 1`)[0]);
	if (!mailbox) throw new Error("Sending is not enabled or permitted for this mailbox");
	const from = `${mailbox.local_part}@${mailbox.hostname}`;
	const messageId = id("msg");
	const jobId = id("job");
	const due = data.scheduledAt ? Math.max(seconds(), Math.floor(Date.parse(data.scheduledAt) / 1000)) : seconds();
	const payload = JSON.stringify({ from, to: data.to, subject: data.subject, text: data.text });
	await withDatabase(sql => sql.begin(async sql => {
		await sql.InsertSentMessage`
			INSERT INTO messages (id,user_id,mailbox_id,direction,from_addr,to_addr,subject,snippet,text_body,status,read,created_at)
			VALUES (${messageId},${user.id},${data.mailboxId},'outbound',${from},${data.to},${data.subject},${data.text.slice(0, 200)},${data.text},'queued',1,${seconds()})`;
		await sql.InsertOutboundJob`
			INSERT INTO outbound_jobs (id,user_id,message_id,status,payload,created_at,updated_at,scheduled_at)
			VALUES (${jobId},${user.id},${messageId},'queued',${payload},${seconds()},${seconds()},${due})`;
	}));
	if (due <= seconds()) await deliverJob(jobId);
	return { messageId, scheduled: due > seconds() };
}
export async function deliverJob(jobId: string) {
	const installation = await getInstallation();
	if (!installation) throw new Error("Cloudflare email is not configured");
	const [job] = await withDatabase(sql => sql.ClaimOutbound`
		UPDATE outbound_jobs SET status='sending',updated_at=${seconds()}
		WHERE id=${jobId} AND status='queued' AND (scheduled_at IS NULL OR scheduled_at<=${seconds()})
		RETURNING id,message_id,payload`);
	if (!job) return;
	try {
		const payload = storedSendSchema.parse(JSON.parse(job.payload));
		// Existing scheduled jobs with attachments require the attachment-send port;
		// never silently send a message with missing files.
		const attachments = await withDatabase(sql => sql.OutboundAttachmentCheck`SELECT id FROM message_attachments WHERE message_id=${job.message_id} LIMIT 1`);
		if (attachments.length) throw new Error("Scheduled attachments require the attachment-send migration");
		const result = await cloudflare(installation.api_token, `/accounts/${installation.account_id}/email/sending/send`,
			z.object({ message_id: z.string().optional(), messageId: z.string().optional() }),
			{ method: "POST", body: JSON.stringify({ ...payload, headers: { "Message-ID": `<${job.id}@${installation.hostname}>` } }) });
		const providerId = result.message_id ?? result.messageId ?? `<${job.id}@${installation.hostname}>`;
		await withDatabase(sql => sql.begin(async sql => {
			await sql.CompleteOutbound`UPDATE outbound_jobs SET status='sent',error=NULL,updated_at=${seconds()} WHERE id=${job.id}`;
			await sql.CompleteSentMessage`UPDATE messages SET status='sent',provider_message_id=${providerId},thread_id=coalesce(thread_id,${providerId}) WHERE id=${job.message_id}`;
		}));
	} catch (error) {
		const message = error instanceof Error ? error.message : "Sending failed";
		await withDatabase(sql => sql.begin(async sql => {
			await sql.FailOutbound`UPDATE outbound_jobs SET status='failed',error=${message},updated_at=${seconds()} WHERE id=${job.id}`;
			await sql.FailSentMessage`UPDATE messages SET status='failed' WHERE id=${job.message_id}`;
		}));
		throw error;
	}
}
