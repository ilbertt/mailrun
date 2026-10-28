import { z } from "zod";
import { getEmailAddress, splitEmailAddressList } from "../lib/email/address";
export const localPartSchema = z
	.string()
	.trim()
	.toLowerCase()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9._%+-]+$/);
const header = z
	.string()
	.refine((value) => !/[\r\n]/.test(value), "Invalid email header");
const recipients = z
	.union([z.string().max(5000), z.array(z.string().max(500)).max(50)])
	.transform((value) =>
		Array.isArray(value) ? value : splitEmailAddressList(value),
	)
	.refine(
		(values) =>
			values.every(
				(value) =>
					!/[\r\n]/.test(value) &&
					z.email().safeParse(getEmailAddress(value)).success,
			),
		"Enter valid email addresses",
	)
	.refine((values) => values.length <= 50, "At most 50 recipients");
export const draftSchema = z.object({
	id: z.string().optional(),
	revision: z.number().int().nonnegative().optional(),
	mailboxId: z.string().min(1),
	from: header.max(500).optional(),
	to: z.string().max(5000).default(""),
	cc: z.string().max(5000).default(""),
	bcc: z.string().max(5000).default(""),
	subject: header.max(998).default(""),
	html: z.string().max(1_000_000).default(""),
	text: z.string().max(1_000_000).default(""),
	inReplyTo: header.max(998).nullable().optional(),
	references: header.max(10000).nullable().optional(),
	threadId: z.string().nullable().optional(),
	scheduledAt: z.iso.datetime().nullable().optional(),
	forwardOfMessageId: z.string().optional(),
});
export const sendDraftSchema = z.object({
	id: z.string(),
	revision: z.number().int().nonnegative(),
});
export const deliveryPayloadSchema = z
	.object({
		from: header.max(500),
		to: recipients.refine(
			(value) => value.length > 0,
			"At least one recipient is required",
		),
		cc: recipients.optional(),
		bcc: recipients.optional(),
		subject: header.max(998),
		text: z.string().optional(),
		html: z.string().optional(),
		inReplyTo: header.max(998).nullable().optional(),
		references: header.max(10000).nullable().optional(),
		threadId: z.string().nullable().optional(),
		returnToDraft: z.boolean().optional(),
		submittedDraftId: z.string().optional(),
		retainSubmittedDraft: z.boolean().optional(),
		approvalId: z.string().optional(),
		autoReplyMailboxId: z.string().optional(),
		autoReplyRecipient: z.email().optional(),
	})
	.refine(
		(value) =>
			value.to.length + (value.cc?.length ?? 0) + (value.bcc?.length ?? 0) <=
			50,
		"At most 50 recipients in total",
	);
export const ruleSchema = z.object({
	id: z.string().optional(),
	domainId: z.string(),
	scope: z.enum(["domain", "mailbox"]).default("domain"),
	name: z.string().trim().max(100).default(""),
	mailboxId: z.string().nullable().optional(),
	enabled: z.boolean().default(true),
	matchField: z.enum(["recipient", "sender", "title", "content", "email"]),
	matchOperator: z.enum([
		"contains",
		"exact",
		"starts_with",
		"ends_with",
		"regex",
	]),
	matchValue: z.string().trim().min(1).max(256),
	action: z.enum(["store", "forward", "reject", "spam", "trash"]),
	forwardTo: z.email().or(z.literal("")).default(""),
	keepCopy: z.boolean().default(false),
	rejectReason: z.string().max(250).default(""),
	priority: z.number().int().min(-10000).max(10000).default(0),
	folderId: z.string().nullable().optional(),
});
export const aliasSchema = z.object({
	mailboxId: z.string(),
	domainId: z.string(),
	localPart: localPartSchema,
});
