import { z } from "zod";

export const userSchema = z.object({
	id: z.string(), email: z.email(), name: z.string(), role: z.enum(["admin", "user"]),
	isPrimaryAdmin: z.boolean(),
});
export type User = z.infer<typeof userSchema>;
export const loginSchema = z.object({
	email: z.email().transform(value => value.toLowerCase().trim()),
	password: z.string().min(1).max(256), code: z.string().max(64).optional(),
});
export const registerSchema = loginSchema.omit({ code: true }).extend({
	password: z.string().min(12).max(256), name: z.string().trim().min(1).max(100),
	setupToken: z.string().min(16).max(256),
});
export const folderSchema = z.enum(["inbox", "sent", "starred", "drafts", "archived", "spam", "trash", "snoozed", "scheduled"]);
export type Folder = z.infer<typeof folderSchema>;
export const listInputSchema = z.object({
	folder: folderSchema.default("inbox"),
	mailboxId: z.string().max(200).optional(),
	q: z.string().trim().max(500).default(""),
	offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export type ListInput = z.infer<typeof listInputSchema>;
export const messageActionSchema = z.object({
	id: z.string().min(1), action: z.enum(["read", "unread", "star", "unstar", "archive", "trash", "inbox"]),
});
export const setupCloudflareSchema = z.object({
	accountId: z.string().regex(/^[a-f0-9]{32}$/),
	hostname: z.string().trim().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/),
	apiToken: z.string().min(20).max(500),
	localPart: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._+-]{0,63}$/),
	activateRouting: z.boolean().default(false),
});
export const relayDecisionSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("store"), messageId: z.string() }),
	z.object({ action: z.literal("reject"), reason: z.string() }),
	z.object({ action: z.literal("forward"), forwardTo: z.email() }),
]);
export const sendSchema = z.object({
	mailboxId: z.string().min(1), to: z.email(), subject: z.string().max(998),
	text: z.string().min(1).max(200_000), scheduledAt: z.iso.datetime().optional(),
});
