import type { CalendarEventRecord } from "../../lib/calendar/types";
import { createCalendarInvitation } from "../../lib/calendar/utils";
import { buildSnippet } from "../../lib/email/parse";
import { deliveryPayloadSchema } from "../../shared/mail-contracts";
import type { User } from "../../shared/contracts";
import { id, seconds, type AppSQL } from "../db";
import { formattedSender } from "../mail/drafts";
import { LocalStorage, deleteUnreferencedObjects } from "../storage";
import { deliverJob } from "../mail/send";
import type { CloudflareFetch } from "../cloudflare/client";
import type { ApiKeyAuthorization } from "../auth/api-key";
import { hasScope } from "../auth/api-key";
export type InvitationPlan = {
	mailboxId: string;
	from: string;
	deliveries: {
		recipient: string;
		messageId: string;
		jobId: string;
		key: string;
	}[];
	bytes: ArrayBuffer;
	subject: string;
	text: string;
};
export async function prepareInvitations(
	user: User,
	key: ApiKeyAuthorization | null,
	event: CalendarEventRecord,
	requestedFrom: string | undefined,
	updated: boolean,
): Promise<InvitationPlan | null> {
	const recipients = JSON.parse(event.attendees) as unknown;
	if (
		!Array.isArray(recipients) ||
		recipients.length === 0 ||
		!event.mailboxId ||
		(updated && !requestedFrom)
	)
		return null;
	if (
		key &&
		(!hasScope(key, "send") ||
			(key.mailboxIds !== null && !key.mailboxIds.includes(event.mailboxId)))
	)
		throw new Response(
			"Sending invitations requires mail send permission for this mailbox",
			{ status: 403 },
		);
	const from = await formattedSender(user, event.mailboxId, requestedFrom);
	const bytes = createCalendarInvitation({ ...event, uid: event.id });
	const subject = `${updated ? "Updated invitation" : "Invitation"}: ${event.title}`,
		text =
			event.description ||
			(updated
				? `This event has been updated: ${event.title}.`
				: `You are invited to ${event.title}.`);
	// Validate the delivery contract before changing the event or writing its attachment.
	const payload = deliveryPayloadSchema.parse({
		from,
		to: recipients,
		subject,
		text,
	});
	return {
		mailboxId: event.mailboxId,
		from,
		deliveries: payload.to.map((recipient) => ({
			recipient,
			messageId: id("msg"),
			jobId: id("job"),
			key: `calendar-invitations/${event.id}/${id("invite")}.ics`,
		})),
		bytes,
		subject,
		text,
	};
}
export async function queueInvitations(
	sql: AppSQL,
	user: User,
	plan: InvitationPlan | null,
): Promise<string[]> {
	if (!plan) return [];
	const jobs: string[] = [];
	for (const { recipient, messageId, jobId, key } of plan.deliveries) {
		const payload = deliveryPayloadSchema.parse({
			from: plan.from,
			to: [recipient],
			subject: plan.subject,
			text: plan.text,
		});
		await sql.NativeCalendarInvitationMessage`INSERT INTO messages (id,user_id,mailbox_id,direction,from_addr,to_addr,subject,text_body,snippet,status,read,created_at) VALUES (${messageId},${user.id},${plan.mailboxId},'outbound',${plan.from},${recipient},${plan.subject},${plan.text},${buildSnippet(plan.text, null)},'queued',1,${seconds()})`;
		await sql.NativeCalendarInvitationFile`INSERT INTO message_attachments (id,message_id,filename,content_type,size,disposition,r2_key,created_at) VALUES (${id("att")},${messageId},'invite.ics','text/calendar; charset=utf-8',${plan.bytes.byteLength},'attachment',${key},${seconds()})`;
		await sql.NativeCalendarInvitationJob`INSERT INTO outbound_jobs (id,user_id,message_id,status,payload,scheduled_at,created_at,updated_at) VALUES (${jobId},${user.id},${messageId},'queued',${JSON.stringify(payload)},${seconds()},${seconds()},${seconds()})`;
		jobs.push(jobId);
	}
	return jobs;
}
export async function withInvitationFiles<T>(
	plan: InvitationPlan | null,
	run: () => Promise<T>,
): Promise<T> {
	const written: string[] = [];
	try {
		if (plan)
			for (const delivery of plan.deliveries) {
				await new LocalStorage().put(delivery.key, plan.bytes);
				written.push(delivery.key);
			}
		return await run();
	} catch (error) {
		await deleteUnreferencedObjects(written);
		throw error;
	}
}

export async function deliverInvitations(
	jobs: string[],
	request: CloudflareFetch = fetch,
) {
	const errors: string[] = [];
	// Bound parallel delivery to fit the nibrun process, while every job is already durable.
	for (let index = 0; index < jobs.length; index += 4) {
		const results = await Promise.allSettled(
			jobs.slice(index, index + 4).map((job) => deliverJob(job, request)),
		);
		for (const result of results)
			if (result.status === "rejected")
				errors.push(
					result.reason instanceof Error
						? result.reason.message
						: "Invitation delivery failed",
				);
	}
	return errors;
}
