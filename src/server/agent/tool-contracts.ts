import { z } from "zod";
import { toolEmailSchema } from "./schema-utils";
import type { EmailToolName } from "./types";
const id = z.string().min(1).max(160);
const body = z
	.string()
	.trim()
	.min(1)
	.max(40_000)
	.describe(
		"The recipient-facing email body as ordinary prose. Do not use Markdown or HTML formatting.",
	);
const limit = z.number().int().min(1).max(50).default(20);

export const emailToolSchemas = {
	list_emails: z.object({
		folder: z
			.enum([
				"inbox",
				"sent",
				"scheduled",
				"draft",
				"archived",
				"trash",
				"spam",
			])
			.default("inbox"),
		limit,
		cursor: id.optional(),
	}),
	get_email: z.object({ emailId: id }),
	get_thread: z.object({ emailId: id }),
	search_emails: z.object({
		query: z.string().trim().min(1).max(300),
		folder: z
			.enum([
				"inbox",
				"sent",
				"scheduled",
				"draft",
				"archived",
				"trash",
				"spam",
			])
			.optional(),
		limit,
	}),
	draft_email: z.object({
		to: toolEmailSchema,
		subject: z.string().trim().min(1).max(500),
		body,
	}),
	draft_reply: z.object({
		emailId: id,
		body,
		replyAll: z.boolean().default(false),
	}),
	edit_draft: z.object({
		draftId: id,
		expectedRevision: z.number().int().positive(),
		from: z.string().max(320).optional(),
		to: z.string().max(2_000).optional(),
		cc: z.string().max(2_000).nullable().optional(),
		bcc: z.string().max(2_000).nullable().optional(),
		subject: z.string().max(500).optional(),
		body: z.string().max(40_000).optional(),
		scheduledAt: z.string().max(40).nullable().optional(),
		addAttachments: z
			.array(z.object({ sourceEmailId: id, attachmentId: id }))
			.max(10)
			.optional(),
		removeAttachmentIds: z.array(id).max(10).optional(),
	}),
	review_draft_send: z.object({
		draftId: id,
		expectedRevision: z.number().int().positive(),
	}),
	mark_email_read: z.object({ emailId: id, read: z.boolean() }),
	move_email: z.object({
		emailId: id,
		destination: z.enum(["inbox", "archived", "trash", "spam"]),
	}),
	move_emails: z.object({
		emailIds: z.array(id).min(1).max(20),
		destination: z.enum(["inbox", "archived", "trash", "spam"]),
	}),
	discard_draft: z.object({
		draftId: id,
		expectedRevision: z.number().int().positive(),
	}),
} as const;

export const emailToolDescriptions: Record<EmailToolName, string> = {
	list_emails: "List email metadata in a mailbox folder with pagination.",
	get_email:
		"Read one email and its attachment metadata without marking it read.",
	get_thread:
		"Read the recent conversation containing an email before drafting a reply.",
	search_emails: "Search email subject and body in this mailbox.",
	draft_email: "Save a new email draft. This never sends.",
	draft_reply:
		"Save a reply draft with recipients and threading derived from the source email. This never sends.",
	edit_draft:
		"Update a draft created by the assistant in the selected mailbox. First read it with get_email to get its current revision and attachment IDs. Can change sender, recipients, subject, body, requested schedule, and copy or remove attachments from accessible emails. Use an ISO 8601 send time with timezone offset; null clears it. This never sends or schedules delivery by itself.",
	review_draft_send:
		"Create a review link for the current assistant draft revision. The user must explicitly confirm before the email is sent or scheduled. This tool never sends or queues an email.",
	mark_email_read: "Mark an email as read or unread.",
	move_email: "Move an email to inbox, archive, trash, or spam.",
	move_emails:
		"Move up to 20 emails to inbox, archive, trash, or spam after user approval in chat.",
	discard_draft: "Discard an unedited agent draft by ID and revision.",
};

export const EMAIL_TOOL_NAMES = Object.keys(
	emailToolSchemas,
) as EmailToolName[];
