import { z } from "zod";
import { withDatabase, id, seconds } from "../db";
import { LocalStorage, deleteUnreferencedObjects } from "../storage";
import { formattedSender } from "../mail/drafts";
import { parseRawMime, buildSnippet } from "../../lib/email/parse";
import type { AttachmentContent } from "../../lib/email/attachment-types";
import {
	normalizeMessageId,
	selectThreadLookupIds,
} from "../../lib/email/thread-lookup";
import { LIMITS } from "./constants";
import { JmapError, invalidArguments } from "./errors";
import { decodeBlobId, decodeMailboxRef, roleToStatus } from "./ids";
import {
	buildEmailObject,
	resolveHeaderProperty,
	mailboxIdsFor,
} from "./email-objects";
import {
	resolveDraftsMailbox,
	importFlags,
	parseReceivedAt,
} from "./email-import-utils";
import { listJmapMailboxes, jmapMutation } from "./access";
import {
	loadMessages,
	jmapAttachments,
	scopeIds,
	type MessageRow,
} from "./repository";
import { readUpload } from "./blobs";
import { getEmailState } from "./state";
import { queryEmailIds } from "./email-query";
import type { JmapContext, JmapMethodHandler, JmapSetError } from "./types";
export { loadMessages };
const listIds = (value: unknown, max = LIMITS.maxObjectsInGet) => {
	if (!Array.isArray(value) || !value.every((id) => typeof id === "string"))
		throw invalidArguments("Expected a list of ids");
	if (value.length > max) throw new JmapError("requestTooLarge");
	return value as string[];
};
const record = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw invalidArguments("Expected an object");
	return value as Record<string, unknown>;
};
const entries = (value: unknown) =>
	Object.entries(value == null ? {} : record(value));
export const emailGet: JmapMethodHandler = async (ctx, args) => {
	if (!args.ids)
		throw new JmapError(
			"requestTooLarge",
			"Email/get needs an explicit list of ids",
		);
	const ids = listIds(args.ids),
		properties =
			args.properties == null ? null : listIds(args.properties, 1000),
		rows = await loadMessages(ctx, ids),
		attachments = await jmapAttachments(
			ctx,
			rows.map((row) => row.id),
		),
		found = new Set(rows.map((row) => row.id));
	const list = rows.map((row) => {
		const full = buildEmailObject(row, attachments.get(row.id) ?? [], {
			fetchBodies: !!(
				args.fetchTextBodyValues ||
				args.fetchHTMLBodyValues ||
				args.fetchAllBodyValues
			),
			maxBodyValueBytes: Math.max(0, Number(args.maxBodyValueBytes ?? 0)),
		});
		if (!properties) return full;
		const picked: Record<string, unknown> = { id: row.id };
		for (const property of properties) {
			if (property.startsWith("header:"))
				picked[property] = resolveHeaderProperty(row, property);
			else if (Object.hasOwn(full, property))
				picked[property] = (full as Record<string, unknown>)[property];
		}
		return picked;
	});
	return {
		accountId: ctx.accountId,
		state: await getEmailState(ctx),
		list,
		notFound: ids.filter((id) => !found.has(id)),
	};
};
export const emailQuery: JmapMethodHandler = async (ctx, args) => {
	const result = await queryEmailIds(ctx, args);
	if ("type" in result) return result;
	return {
		accountId: ctx.accountId,
		queryState: await getEmailState(ctx),
		canCalculateChanges: false,
		...result,
	};
};
export const emailChanges: JmapMethodHandler = async () => ({
	type: "cannotCalculateChanges",
	description: "Email change history is not kept; run Email/query again.",
});
export const emailQueryChanges: JmapMethodHandler = async () => ({
	type: "cannotCalculateChanges",
});
export const emailUnsupported =
	(method: string): JmapMethodHandler =>
	async () => ({
		type: "unknownMethod",
		description: `${method} is not supported`,
	});
type Draft = {
	mailboxId: string;
	fromAddr: string;
	toAddr: string;
	ccAddr: string | null;
	bccAddr: string | null;
	subject: string | null;
	textBody: string | null;
	htmlBody: string | null;
	inReplyTo: string | null;
	references: string | null;
	read?: boolean;
	starred?: boolean;
	providerMessageId?: string | null;
	createdAt?: Date;
};
async function persistDraft(
	ctx: JmapContext,
	row: Draft,
	attachments: AttachmentContent[],
	raw?: ArrayBuffer,
	claim?: string,
) {
	if (
		attachments.length > 10 ||
		attachments.reduce((sum, item) => sum + item.content.byteLength, 0) >
			25_000_000
	)
		throw new JmapError("tooLarge", "Attachments exceed the 25 MB total limit");
	const messageId = id("msg"),
		storage = new LocalStorage(),
		written: string[] = [],
		files: { id: string; key: string; item: AttachmentContent }[] = [];
	let committed = false,
		claimedKey: string | undefined;
	const rawKey = raw ? `drafts/${messageId}.eml` : null;
	try {
		if (raw && rawKey) {
			await storage.put(rawKey, raw);
			written.push(rawKey);
		}
		for (const item of attachments) {
			const attachmentId = id("att"),
				key = `attachments/${messageId}/${attachmentId}`;
			await storage.put(key, item.content);
			written.push(key);
			files.push({ id: attachmentId, key, item });
		}
		await jmapMutation(ctx, row.mailboxId, "write", async (sql) => {
			if (claim) {
				const [claimed] =
					await sql.NativeJmapClaimUpload`DELETE FROM mailrun_jmap_uploads WHERE id=${claim} AND user_id=${ctx.auth.userId} RETURNING r2_key`;
				if (!claimed) throw new JmapError("blobNotFound");
				claimedKey = claimed.r2_key;
			}
			const refs = selectThreadLookupIds(
				row.inReplyTo,
				row.references?.split(/\s+/) ?? [],
			).flatMap((value) => [value, `<${value}>`]);
			const [parent] =
				raw && refs.length
					? await sql.NativeJmapImportThread`SELECT thread_id,provider_message_id FROM messages WHERE mailbox_id=${row.mailboxId} AND provider_message_id IN(SELECT value FROM json_each(${JSON.stringify(refs)})) ORDER BY created_at LIMIT 1`
					: [];
			const thread = raw
				? (parent?.thread_id ??
					normalizeMessageId(parent?.provider_message_id) ??
					normalizeMessageId(row.providerMessageId) ??
					id("thr"))
				: null;
			await sql.NativeJmapInsertDraft`INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,cc_addr,bcc_addr,subject,snippet,text_body,html_body,status,read,starred,in_reply_to,references_header,thread_id,provider_message_id,raw_r2_key,created_at) VALUES(${messageId},${ctx.auth.userId},${row.mailboxId},'outbound',${row.fromAddr},${row.toAddr},${row.ccAddr},${row.bccAddr},${row.subject},${buildSnippet(row.textBody, row.htmlBody)},${row.textBody},${row.htmlBody},'draft',${row.read === false ? 0 : 1},${row.starred ? 1 : 0},${row.inReplyTo},${row.references},${thread},${row.providerMessageId ?? null},${rawKey},${row.createdAt ? Math.floor(row.createdAt.getTime() / 1000) : seconds()})`;
			for (const file of files)
				await sql.NativeJmapDraftAttachment`INSERT INTO message_attachments(id,message_id,filename,content_type,size,disposition,content_id,r2_key,created_at) VALUES(${file.id},${messageId},${file.item.filename.trim().replace(/[/\\\0]/g, "_") || "attachment"},${file.item.type},${file.item.content.byteLength},${file.item.disposition ?? "attachment"},${file.item.contentId ?? null},${file.key},${seconds()})`;
		});
		committed = true;
		if (claimedKey)
			await deleteUnreferencedObjects([claimedKey]).catch((error) =>
				console.warn("Claimed JMAP upload cleanup failed", error),
			);
		return messageId;
	} finally {
		if (!committed) await deleteUnreferencedObjects(written);
	}
}
const addresses = (value: unknown) => {
	if (value == null) return "";
	if (!Array.isArray(value))
		throw invalidArguments("Addresses must be an array");
	return value
		.map((item) => {
			const address = z
				.object({ email: z.string(), name: z.string().nullable().optional() })
				.parse(item);
			if (/[\r\n]/.test(address.email + (address.name ?? "")))
				throw invalidArguments("Invalid address header");
			return address.name
				? `"${address.name.replace(/"/g, '\\"')}" <${address.email}>`
				: address.email;
		})
		.join(", ");
};
async function createDraft(
	ctx: JmapContext,
	value: Record<string, unknown>,
	writable: Set<string>,
) {
	const target = resolveDraftsMailbox(value.mailboxIds, writable);
	if ("error" in target)
		throw new JmapError(
			target.error.type,
			target.error.description,
			target.error.properties ? { properties: target.error.properties } : {},
		);
	const from = Array.isArray(value.from)
		? record(value.from[0] ?? {}).email
		: undefined;
	if (typeof from !== "string")
		throw new JmapError("invalidProperties", "A From address is required", {
			properties: ["from"],
		});
	const sender = await formattedSender(ctx.auth.user, target.mailboxId, from),
		body = record(value.bodyValues ?? {});
	const partText = (parts: unknown) => {
		if (!Array.isArray(parts) || !parts.length) return "";
		const id = record(parts[0]).partId;
		if (typeof id !== "string") return "";
		const part = body[id];
		return part &&
			typeof part === "object" &&
			typeof record(part).value === "string"
			? String(record(part).value)
			: "";
	};
	const attachments: AttachmentContent[] = [];
	for (const rawPart of value.attachments == null
		? []
		: Array.isArray(value.attachments)
			? value.attachments
			: []) {
		const part = record(rawPart),
			blob = typeof part.blobId === "string" ? decodeBlobId(part.blobId) : null;
		if (!blob || blob.kind !== "up") continue;
		const upload = await readUpload(ctx, blob.id);
		if (!upload) continue;
		attachments.push({
			filename:
				typeof part.name === "string"
					? part.name
					: (upload.name ?? "attachment"),
			type: typeof part.type === "string" ? part.type : upload.type,
			content: upload.content,
			disposition: part.disposition === "inline" ? "inline" : "attachment",
			contentId: typeof part.cid === "string" ? part.cid : null,
		});
		if (
			attachments.reduce((sum, item) => sum + item.content.byteLength, 0) >
			25_000_000
		)
			throw new JmapError("tooLarge");
	}
	return persistDraft(
		ctx,
		{
			mailboxId: target.mailboxId,
			fromAddr: sender,
			toAddr: addresses(value.to),
			ccAddr: addresses(value.cc) || null,
			bccAddr: addresses(value.bcc) || null,
			subject: typeof value.subject === "string" ? value.subject : null,
			textBody: partText(value.textBody) || null,
			htmlBody: partText(value.htmlBody) || null,
			inReplyTo:
				Array.isArray(value.inReplyTo) && typeof value.inReplyTo[0] === "string"
					? value.inReplyTo[0]
					: null,
			references: Array.isArray(value.references)
				? listIds(value.references, 1000).join(" ")
				: null,
		},
		attachments,
	);
}
function target(
	row: MessageRow,
	patch: Record<string, unknown>,
	accessible: Set<string>,
) {
	let ids: string[] | undefined;
	if (patch.mailboxIds && typeof patch.mailboxIds === "object")
		ids = Object.entries(record(patch.mailboxIds))
			.filter(([, on]) => on)
			.map(([id]) => id);
	else {
		const current = new Set(Object.keys(mailboxIdsFor(row)));
		let touched = false;
		for (const [key, value] of Object.entries(patch)) {
			if (!key.startsWith("mailboxIds/")) continue;
			touched = true;
			const id = key.slice(11);
			if (value) current.add(id);
			else current.delete(id);
		}
		if (touched) ids = [...current];
	}
	if (!ids) return null;
	if (ids.length !== 1)
		throw new JmapError(
			"invalidProperties",
			"A message belongs to exactly one mailbox",
			{ properties: ["mailboxIds"] },
		);
	const ref = decodeMailboxRef(ids[0]!);
	if (
		!ref ||
		!accessible.has(ref.mailboxId) ||
		ref.mailboxId !== row.mailboxId ||
		ref.kind === "account" ||
		(ref.kind === "role" && ref.role === "sent" && row.direction === "inbound")
	)
		throw new JmapError("invalidProperties", "Unknown or invalid mailbox", {
			properties: ["mailboxIds"],
		});
	return ref.kind === "folder"
		? {
				status:
					row.direction === "outbound" && row.status !== "draft"
						? "sent"
						: "received",
				folderId: ref.folderId,
			}
		: { status: roleToStatus(ref.role), folderId: null };
}
function flags(patch: Record<string, unknown>) {
	const result: { read?: boolean; starred?: boolean } = {};
	const apply = (key: string, value: unknown) => {
		if (key === "$seen") result.read = !!value;
		if (key === "$flagged") result.starred = !!value;
	};
	if (patch.keywords && typeof patch.keywords === "object") {
		const map = record(patch.keywords);
		result.read = !!map.$seen;
		result.starred = !!map.$flagged;
	}
	for (const [key, value] of Object.entries(patch))
		if (key.startsWith("keywords/")) apply(key.slice(9), value);
	return result;
}
function setError(error: unknown): JmapSetError {
	return error instanceof JmapError
		? { type: error.type, description: error.message, ...error.extra }
		: {
				type: "forbidden",
				description:
					error instanceof Error ? error.message : "Operation failed",
			};
}
export async function destroyMessage(
	ctx: JmapContext,
	row: MessageRow,
	force = false,
) {
	if (!row.mailboxId) throw new JmapError("notFound");
	const keys = await jmapMutation(ctx, row.mailboxId, "write", async (sql) => {
		const [current] =
			await sql.NativeJmapDestroyMessageGuard`SELECT status,raw_r2_key FROM messages WHERE id=${row.id} AND mailbox_id=${row.mailboxId} AND (status!='draft' OR user_id=${ctx.auth.userId})`;
		if (!current) throw new JmapError("notFound");
		const [sending] =
			await sql.NativeJmapMessageSending`SELECT id FROM outbound_jobs WHERE status IN('queued','sending') AND ((message_id=${row.id} AND (status='sending' OR json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.submittedDraftId') IS NOT NULL)) OR json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.submittedDraftId')=${row.id}) LIMIT 1`;
		if (sending) throw new JmapError("forbidden", "A message is being sent");
		await sql.NativeJmapCancelMessageJobs`UPDATE outbound_jobs SET status='cancelled',updated_at=${seconds()} WHERE message_id=${row.id} AND status='queued'`;
		if (force || current.status === "trash" || current.status === "draft") {
			const files =
				await sql.NativeJmapDestroyAttachments`SELECT r2_key FROM message_attachments WHERE message_id=${row.id}`;
			await sql.NativeJmapDeleteEmail`DELETE FROM messages WHERE id=${row.id}`;
			return [
				...files.map((file) => file.r2_key),
				...(current.raw_r2_key ? [current.raw_r2_key] : []),
			];
		}
		await sql.NativeJmapTrashEmail`UPDATE messages SET status='trash',folder_id=NULL WHERE id=${row.id}`;
		return [];
	});
	await deleteUnreferencedObjects(keys);
}
export const emailSet: JmapMethodHandler = async (ctx, args) => {
	const oldState = await getEmailState(ctx);
	if (args.ifInState && args.ifInState !== oldState)
		return { type: "stateMismatch" };
	const boxes = await listJmapMailboxes(ctx),
		accessible = new Set(boxes.map((box) => box.id)),
		writable = new Set(
			boxes
				.filter((box) => box.permission !== "read_only")
				.map((box) => box.id),
		);
	const created: Record<string, unknown> = Object.create(null),
		notCreated: Record<string, unknown> = Object.create(null),
		updated: Record<string, null> = Object.create(null),
		notUpdated: Record<string, unknown> = Object.create(null),
		destroyed: string[] = [],
		notDestroyed: Record<string, unknown> = Object.create(null);
	const create = entries(args.create),
		updates = entries(args.update),
		destroys =
			args.destroy == null ? [] : listIds(args.destroy, LIMITS.maxObjectsInSet);
	if (create.length + updates.length + destroys.length > LIMITS.maxObjectsInSet)
		throw new JmapError("requestTooLarge");
	for (const [creationId, value] of create) {
		try {
			const id = await createDraft(ctx, record(value), writable);
			ctx.createdIds[creationId] = id;
			const [row] = await loadMessages(ctx, [id]);
			created[creationId] = row
				? buildEmailObject(row, [], {
						fetchBodies: false,
						maxBodyValueBytes: 0,
					})
				: { id };
		} catch (error) {
			notCreated[creationId] = setError(error);
		}
	}
	const byId = new Map(
		(
			await loadMessages(
				ctx,
				updates.map(([id]) => id),
			)
		).map((row) => [row.id, row]),
	);
	for (const [id, value] of updates) {
		const row = byId.get(id);
		if (!row?.mailboxId) {
			notUpdated[id] = { type: "notFound" };
			continue;
		}
		if (!writable.has(row.mailboxId)) {
			notUpdated[id] = { type: "forbidden" };
			continue;
		}
		try {
			const patch = record(value),
				move = target(row, patch, accessible),
				values = flags(patch);
			await jmapMutation(ctx, row.mailboxId, "write", async (sql) => {
				if (move?.folderId) {
					const [folder] =
						await sql.NativeJmapMoveFolder`SELECT id FROM folders WHERE id=${move.folderId} AND mailbox_id=${row.mailboxId}`;
					if (!folder)
						throw new JmapError("invalidProperties", "Unknown folder", {
							properties: ["mailboxIds"],
						});
				}
				const [sending] =
					await sql.NativeJmapUpdateSending`SELECT id FROM outbound_jobs WHERE status IN('queued','sending') AND ((message_id=${id} AND (status='sending' OR json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.submittedDraftId') IS NOT NULL)) OR json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.submittedDraftId')=${id}) LIMIT 1`;
				if (sending && move)
					throw new JmapError("forbidden", "A message is being sent");
				if (move)
					await sql.NativeJmapCancelMovedJobs`UPDATE outbound_jobs SET status='cancelled',updated_at=${seconds()} WHERE message_id=${id} AND status='queued'`;
				if (move || values.read !== undefined || values.starred !== undefined) {
					const [changed] =
						await sql.NativeJmapUpdateEmail`UPDATE messages SET read=coalesce(${values.read === undefined ? null : values.read ? 1 : 0},read),starred=coalesce(${values.starred === undefined ? null : values.starred ? 1 : 0},starred),status=coalesce(${move?.status ?? null},status),folder_id=CASE WHEN ${move ? 1 : 0}=1 THEN ${move?.folderId ?? null} ELSE folder_id END,draft_revision=draft_revision+CASE WHEN status='draft' THEN 1 ELSE 0 END WHERE id=${id} AND mailbox_id=${row.mailboxId} AND (status!='draft' OR user_id=${ctx.auth.userId}) RETURNING id`;
					if (!changed) throw new JmapError("notFound");
				}
			});
			updated[id] = null;
		} catch (error) {
			notUpdated[id] = setError(error);
		}
	}
	const destroyById = new Map(
		(await loadMessages(ctx, destroys)).map((row) => [row.id, row]),
	);
	for (const id of destroys) {
		const row = destroyById.get(id);
		if (!row?.mailboxId) {
			notDestroyed[id] = { type: "notFound" };
			continue;
		}
		if (!writable.has(row.mailboxId)) {
			notDestroyed[id] = { type: "forbidden" };
			continue;
		}
		try {
			await destroyMessage(ctx, row);
			destroyed.push(id);
		} catch (error) {
			notDestroyed[id] = setError(error);
		}
	}
	return {
		accountId: ctx.accountId,
		oldState,
		newState: await getEmailState(ctx),
		created,
		updated,
		destroyed,
		notCreated,
		notUpdated,
		notDestroyed,
	};
};
export const emailImport: JmapMethodHandler = async (ctx, args) => {
	const oldState = await getEmailState(ctx);
	if (args.ifInState && args.ifInState !== oldState)
		return { type: "stateMismatch" };
	const emails = entries(args.emails);
	if (emails.length > LIMITS.maxObjectsInSet)
		throw new JmapError("requestTooLarge");
	const writable = new Set(
			(await listJmapMailboxes(ctx))
				.filter((box) => box.permission !== "read_only")
				.map((box) => box.id),
		),
		created: Record<string, unknown> = Object.create(null),
		notCreated: Record<string, unknown> = Object.create(null);
	for (const [creationId, rawValue] of emails) {
		try {
			const value = record(rawValue),
				target = resolveDraftsMailbox(value.mailboxIds, writable);
			if ("error" in target)
				throw new JmapError(target.error.type, target.error.description, {
					properties: ["mailboxIds"],
				});
			const blob =
				typeof value.blobId === "string" ? decodeBlobId(value.blobId) : null;
			if (!blob || blob.kind !== "up")
				throw new JmapError(
					"blobNotFound",
					"blobId must name an upload from this account",
				);
			const upload = await readUpload(ctx, blob.id);
			if (!upload) throw new JmapError("blobNotFound", "No such upload");
			if (!upload.content.byteLength)
				throw new JmapError("invalidEmail", "The blob is empty");
			let parsed: Awaited<ReturnType<typeof parseRawMime>>;
			try {
				parsed = await parseRawMime(upload.content);
			} catch {
				throw new JmapError("invalidEmail");
			}
			if (!parsed.fromAddr)
				throw new JmapError("invalidEmail", "The message has no From header");
			const from = await formattedSender(
					ctx.auth.user,
					target.mailboxId,
					parsed.fromAddr,
				),
				flags = importFlags(value.keywords),
				id = await persistDraft(
					ctx,
					{
						mailboxId: target.mailboxId,
						fromAddr: from,
						toAddr: parsed.toAddr ?? "",
						ccAddr: parsed.ccAddr,
						bccAddr: parsed.bccAddr,
						subject: parsed.subject,
						textBody: parsed.text,
						htmlBody: parsed.html,
						inReplyTo: parsed.inReplyTo,
						references: parsed.references.join(" ") || null,
						providerMessageId: parsed.messageId,
						createdAt:
							parseReceivedAt(value.receivedAt) ?? parsed.date ?? new Date(),
						...flags,
					},
					parsed.attachments,
					upload.content,
					blob.id,
				);
			ctx.createdIds[creationId] = id;
			const [row] = await loadMessages(ctx, [id]);
			if (!row) throw new JmapError("serverFail");
			const object = buildEmailObject(
				row,
				(await jmapAttachments(ctx, [id])).get(id) ?? [],
				{ fetchBodies: false, maxBodyValueBytes: 0 },
			);
			created[creationId] = {
				id,
				blobId: object.blobId,
				threadId: object.threadId,
				size: object.size,
			};
		} catch (error) {
			notCreated[creationId] = setError(error);
		}
	}
	return {
		accountId: ctx.accountId,
		oldState,
		newState: await getEmailState(ctx),
		created,
		notCreated,
	};
};
export const threadGet: JmapMethodHandler = async (ctx, args) => {
	if (!args.ids)
		throw new JmapError(
			"requestTooLarge",
			"Thread/get needs an explicit list of ids",
		);
	const ids = listIds(args.ids),
		boxes = await scopeIds(ctx),
		fallback = !boxes.length && !ctx.auth.mailboxIds;
	const rows = await withDatabase(
		(sql) =>
			sql.NativeJmapThreads`/* @type thread string */ SELECT id,coalesce(thread_id,id) AS thread FROM messages WHERE coalesce(thread_id,id) IN(SELECT value FROM json_each(${JSON.stringify(ids)})) AND (mailbox_id IN(SELECT value FROM json_each(${JSON.stringify(boxes)})) OR (${fallback ? 1 : 0}=1 AND user_id=${ctx.auth.userId})) AND (status!='draft' OR user_id=${ctx.auth.userId}) ORDER BY created_at,rowid`,
	);
	const grouped = new Map<string, string[]>();
	for (const row of rows)
		grouped.set(row.thread, [...(grouped.get(row.thread) ?? []), row.id]);
	return {
		accountId: ctx.accountId,
		state: await getEmailState(ctx),
		list: [...grouped].map(([id, emailIds]) => ({ id, emailIds })),
		notFound: ids.filter((id) => !grouped.has(id)),
	};
};
export const threadChanges: JmapMethodHandler = async () => ({
	type: "cannotCalculateChanges",
});
export const searchSnippetGet: JmapMethodHandler = async (ctx, args) => {
	const ids = (args.emailIds as string[]) ?? [];
	const filter = (args.filter ?? {}) as {
		text?: string;
		subject?: string;
		body?: string;
	};
	const term = (filter.text ?? filter.body ?? filter.subject ?? "").trim();
	const rows = await loadMessages(ctx, ids);
	const found = new Set<string>();
	const escape = (value: string) =>
		value.replace(
			/[&<>]/g,
			(char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!,
		);
	const highlight = (value: string | null) => {
		if (!value) return null;
		if (!term) return escape(value);
		const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
		return escape(value).replace(re, (match) => `<mark>${match}</mark>`);
	};
	const list = rows.map((row) => {
		found.add(row.id);
		const body = row.textBody ?? row.snippet ?? "";
		let excerpt: string | null = null;
		if (term) {
			const index = body.toLowerCase().indexOf(term.toLowerCase());
			if (index >= 0)
				excerpt = highlight(body.slice(Math.max(index - 80, 0), index + 160));
		}
		return {
			emailId: row.id,
			subject: highlight(row.subject),
			preview: excerpt,
		};
	});
	return {
		accountId: ctx.accountId,
		list,
		notFound: ids.filter((id) => !found.has(id)),
	};
};
