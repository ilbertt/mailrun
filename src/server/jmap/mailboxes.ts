import { withDatabase, id, seconds } from "../db";
import {
	jmapMutation,
	listFoldersByMailbox,
	listJmapMailboxes,
} from "./access";
import {
	decodeMailboxRef,
	encodeMailboxRef,
	roleToStatus,
	SYSTEM_ROLES,
} from "./ids";
import { getMailboxState } from "./state";
import { JmapError } from "./errors";
import type {
	AccessibleMailbox,
	JmapContext,
	JmapMethodHandler,
	SystemRole,
} from "./types";
const ROLE_NAMES: Record<SystemRole, string> = {
	inbox: "Inbox",
	sent: "Sent",
	drafts: "Drafts",
	archive: "Archive",
	junk: "Spam",
	trash: "Trash",
};
const ROLE_ORDER: Record<SystemRole, number> = {
	inbox: 1,
	drafts: 2,
	sent: 3,
	archive: 4,
	junk: 5,
	trash: 6,
};

type Counts = { total: number; unread: number };

/**
 * Per-mailbox tallies in one pass: rows grouped by (mailbox, status, folder)
 * are folded into the JMAP Mailbox each combination belongs to.
 */
async function loadCounts(
	ctx: JmapContext,
	ids: string[],
): Promise<Map<string, Counts>> {
	const result = new Map<string, Counts>();
	if (!ids.length) return result;
	const rows = await withDatabase(
		(sql) => sql.NativeJmapMailboxCounts`/* @type total number */
/* @type unread number */
SELECT mailbox_id,status,folder_id,count(*) AS total,CAST(sum(CASE WHEN read=0 AND direction='inbound' THEN 1 ELSE 0 END) AS INTEGER) AS unread FROM messages WHERE mailbox_id IN(SELECT value FROM json_each(${JSON.stringify(ids)})) AND (status!='draft' OR user_id=${ctx.auth.userId}) GROUP BY mailbox_id,status,folder_id`,
	);
	const add = (key: string, row: Counts) => {
		const old = result.get(key) ?? { total: 0, unread: 0 };
		result.set(key, {
			total: old.total + row.total,
			unread: old.unread + row.unread,
		});
	};
	for (const row of rows) {
		if (!row.mailbox_id) continue;
		add(encodeMailboxRef({ kind: "account", mailboxId: row.mailbox_id }), row);
		if (row.folder_id)
			add(
				encodeMailboxRef({
					kind: "folder",
					mailboxId: row.mailbox_id,
					folderId: row.folder_id,
				}),
				row,
			);
		else {
			const role = statusRole(row.status);
			if (role)
				add(
					encodeMailboxRef({ kind: "role", mailboxId: row.mailbox_id, role }),
					row,
				);
		}
	}
	return result;
}

function statusRole(status: string): SystemRole | null {
	for (const role of SYSTEM_ROLES)
		if (roleToStatus(role) === status) return role;
	if (status === "queued" || status === "failed") return "sent";
	return null;
}

function rights(mailbox: AccessibleMailbox, system: boolean) {
	const canWrite = mailbox.permission !== "read_only";
	const canSend =
		mailbox.permission === "send_as" ||
		mailbox.permission === "send_on_behalf" ||
		mailbox.permission === "full_access";
	return {
		mayReadItems: true,
		mayAddItems: canWrite,
		mayRemoveItems: canWrite,
		maySetSeen: canWrite,
		maySetKeywords: canWrite,
		mayCreateChild: mailbox.permission === "full_access",
		mayRename: !system && mailbox.permission === "full_access",
		mayDelete: !system && mailbox.permission === "full_access",
		maySubmit: canSend,
	};
}

/** Every Mailbox object visible to the account. */
export async function buildAllMailboxes(ctx: JmapContext) {
	const accessible = await listJmapMailboxes(ctx);
	const ids = accessible.map((row) => row.id);
	const [foldersByMailbox, counts] = await Promise.all([
		listFoldersByMailbox(ctx, ids),
		loadCounts(ctx, ids),
	]);
	const list: Array<Record<string, unknown>> = [];
	let sortBase = 0;

	for (const mailbox of accessible) {
		const address = `${mailbox.localPart}@${mailbox.hostname}`;
		const accountId = encodeMailboxRef({
			kind: "account",
			mailboxId: mailbox.id,
		});
		const accountCounts = counts.get(accountId) ?? { total: 0, unread: 0 };
		list.push({
			id: accountId,
			name: mailbox.displayName
				? `${mailbox.displayName} <${address}>`
				: address,
			parentId: null,
			role: null,
			sortOrder: sortBase,
			totalEmails: accountCounts.total,
			unreadEmails: accountCounts.unread,
			totalThreads: accountCounts.total,
			unreadThreads: accountCounts.unread,
			myRights: rights(mailbox, true),
			isSubscribed: true,
		});
		for (const role of SYSTEM_ROLES) {
			const id = encodeMailboxRef({
				kind: "role",
				mailboxId: mailbox.id,
				role,
			});
			const c = counts.get(id) ?? { total: 0, unread: 0 };
			list.push({
				id,
				name: ROLE_NAMES[role],
				parentId: accountId,
				role,
				sortOrder: sortBase + ROLE_ORDER[role],
				totalEmails: c.total,
				unreadEmails: role === "inbox" ? c.unread : 0,
				totalThreads: c.total,
				unreadThreads: role === "inbox" ? c.unread : 0,
				myRights: rights(mailbox, true),
				isSubscribed: true,
			});
		}
		for (const folder of foldersByMailbox.get(mailbox.id) ?? []) {
			const id = encodeMailboxRef({
				kind: "folder",
				mailboxId: mailbox.id,
				folderId: folder.id,
			});
			const c = counts.get(id) ?? { total: 0, unread: 0 };
			list.push({
				id,
				name: folder.name,
				parentId: accountId,
				role: null,
				sortOrder: sortBase + 10,
				totalEmails: c.total,
				unreadEmails: c.unread,
				totalThreads: c.total,
				unreadThreads: c.unread,
				myRights: rights(mailbox, false),
				isSubscribed: true,
			});
		}
		sortBase += 100;
	}
	return list;
}

export const mailboxGet: JmapMethodHandler = async (ctx, args) => {
	const all = await buildAllMailboxes(ctx);
	const ids = args.ids as string[] | null | undefined;
	const properties = args.properties as string[] | null | undefined;
	const wanted = ids
		? all.filter((item) => ids.includes(item.id as string))
		: all;
	const found = new Set(wanted.map((item) => item.id as string));
	return {
		accountId: ctx.accountId,
		state: await getMailboxState(ctx),
		list: wanted.map((item) => pick(item, properties)),
		notFound: ids ? ids.filter((id) => !found.has(id)) : [],
	};
};

export const mailboxQuery: JmapMethodHandler = async (ctx, args) => {
	const all = await buildAllMailboxes(ctx);
	const filter = (args.filter ?? {}) as {
		parentId?: string | null;
		name?: string;
		role?: string | null;
		hasAnyRole?: boolean;
	};
	let rows = all;
	if (filter.parentId !== undefined)
		rows = rows.filter((item) => item.parentId === filter.parentId);
	if (filter.name)
		rows = rows.filter((item) =>
			String(item.name).toLowerCase().includes(filter.name!.toLowerCase()),
		);
	if (filter.role !== undefined)
		rows = rows.filter((item) => item.role === filter.role);
	if (filter.hasAnyRole !== undefined)
		rows = rows.filter((item) => (item.role !== null) === filter.hasAnyRole);
	rows = [...rows].sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder));
	const position = Math.max(Number(args.position ?? 0), 0);
	const limit =
		args.limit == null ? rows.length : Math.max(Number(args.limit), 0);
	return {
		accountId: ctx.accountId,
		queryState: await getMailboxState(ctx),
		canCalculateChanges: false,
		position,
		ids: rows.slice(position, position + limit).map((item) => item.id),
		total: rows.length,
	};
};

export const mailboxChanges: JmapMethodHandler = async () => {
	return {
		type: "cannotCalculateChanges",
		description: "Mailbox change history is not kept; run Mailbox/get again.",
	};
};

export const mailboxSet: JmapMethodHandler = async (ctx, args) => {
	const oldState = await getMailboxState(ctx);
	if (args.ifInState && args.ifInState !== oldState)
		return { type: "stateMismatch" };
	const accessible = await listJmapMailboxes(ctx),
		created: Record<string, unknown> = Object.create(null),
		notCreated: Record<string, unknown> = Object.create(null),
		updated: Record<string, null> = Object.create(null),
		notUpdated: Record<string, unknown> = Object.create(null),
		destroyed: string[] = [],
		notDestroyed: Record<string, unknown> = Object.create(null);
	for (const [creationId, value] of Object.entries(
		(args.create ?? {}) as Record<string, Record<string, unknown>>,
	)) {
		const parent =
				typeof value.parentId === "string"
					? decodeMailboxRef(value.parentId)
					: null,
			name = typeof value.name === "string" ? value.name.trim() : "",
			box = parent && accessible.find((box) => box.id === parent.mailboxId);
		if (
			!parent ||
			parent.kind !== "account" ||
			!box ||
			box.permission !== "full_access"
		) {
			notCreated[creationId] = {
				type: "invalidProperties",
				properties: ["parentId"],
				description: "Folders live directly under a mailbox",
			};
			continue;
		}
		if (!name || name.length > 80) {
			notCreated[creationId] = {
				type: "invalidProperties",
				properties: ["name"],
			};
			continue;
		}
		const folderId = id("fld");
		try {
			await jmapMutation(ctx, box.id, "manage", async (sql) => {
				await sql.NativeJmapCreateFolder`INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES(${folderId},${box.userId},${box.id},${name},${seconds()})`;
			});
		} catch (error) {
			notCreated[creationId] = {
				type: error instanceof JmapError ? error.type : "invalidProperties",
				properties: ["name"],
				description: "A folder with that name already exists",
			};
			continue;
		}
		const valueId = encodeMailboxRef({
			kind: "folder",
			mailboxId: box.id,
			folderId: folderId,
		});
		ctx.createdIds[creationId] = valueId;
		created[creationId] = {
			id: valueId,
			role: null,
			sortOrder: 0,
			totalEmails: 0,
			unreadEmails: 0,
			totalThreads: 0,
			unreadThreads: 0,
			isSubscribed: true,
		};
	}
	for (const [folderId, patch] of Object.entries(
		(args.update ?? {}) as Record<string, Record<string, unknown>>,
	)) {
		const ref = decodeMailboxRef(folderId),
			box = ref && accessible.find((box) => box.id === ref.mailboxId),
			keys = Object.keys(patch).filter(
				(key) => key !== "isSubscribed" && key !== "sortOrder",
			);
		if (!ref || !box) {
			notUpdated[folderId] = { type: "notFound" };
			continue;
		}
		if (ref.kind !== "folder") {
			if (keys.length)
				notUpdated[folderId] = {
					type: "forbidden",
					description: "System mailboxes cannot be changed",
				};
			else updated[folderId] = null;
			continue;
		}
		if (box.permission !== "full_access") {
			notUpdated[folderId] = { type: "forbidden" };
			continue;
		}
		if (
			keys.some((key) => key !== "name") ||
			(patch.name !== undefined &&
				(typeof patch.name !== "string" ||
					!patch.name.trim() ||
					patch.name.length > 80))
		) {
			notUpdated[folderId] = { type: "invalidProperties", properties: keys };
			continue;
		}
		try {
			await jmapMutation(ctx, box.id, "manage", async (sql) => {
				const [row] =
					await sql.NativeJmapRenameFolder`UPDATE folders SET name=coalesce(${typeof patch.name === "string" ? patch.name.trim() : null},name) WHERE id=${ref.folderId} AND mailbox_id=${box.id} RETURNING id`;
				if (!row) throw new JmapError("notFound");
			});
			updated[folderId] = null;
		} catch (error) {
			notUpdated[folderId] = {
				type: error instanceof JmapError ? error.type : "invalidProperties",
			};
		}
	}
	for (const folderId of (args.destroy ?? []) as string[]) {
		const ref = decodeMailboxRef(folderId),
			box = ref && accessible.find((box) => box.id === ref.mailboxId);
		if (!ref || !box) {
			notDestroyed[folderId] = { type: "notFound" };
			continue;
		}
		if (ref.kind !== "folder" || box.permission !== "full_access") {
			notDestroyed[folderId] = { type: "forbidden" };
			continue;
		}
		try {
			await jmapMutation(ctx, box.id, "manage", async (sql) => {
				const [folder] =
					await sql.NativeJmapDestroyFolderGuard`SELECT id FROM folders WHERE id=${ref.folderId} AND mailbox_id=${box.id}`;
				if (!folder) throw new JmapError("notFound");
				const [sending] =
					await sql.NativeJmapFolderSending`SELECT j.id FROM outbound_jobs j JOIN messages m ON (m.id=j.message_id OR m.id=json_extract(CASE WHEN json_valid(j.payload) THEN j.payload ELSE '{}' END,'$.submittedDraftId')) WHERE m.folder_id=${ref.folderId} AND ((m.id=j.message_id AND j.status='sending') OR (m.id=json_extract(CASE WHEN json_valid(j.payload) THEN j.payload ELSE '{}' END,'$.submittedDraftId') AND j.status IN('queued','sending'))) LIMIT 1`;
				if (sending)
					throw new JmapError("forbidden", "A message is being sent");
				if (args.onDestroyRemoveEmails) {
					await sql.NativeJmapCancelFolderJobs`UPDATE outbound_jobs SET status='cancelled',updated_at=${seconds()} WHERE status='queued' AND message_id IN(SELECT id FROM messages WHERE folder_id=${ref.folderId})`;
					await sql.NativeJmapTrashFolder`UPDATE messages SET status='trash',folder_id=NULL WHERE folder_id=${ref.folderId} AND (status!='draft' OR user_id=${ctx.auth.userId})`;
				} else {
					const [message] =
						await sql.NativeJmapFolderUsed`SELECT id FROM messages WHERE folder_id=${ref.folderId} AND snoozed_until IS NULL LIMIT 1`;
					if (message) throw new JmapError("mailboxHasEmail");
				}
				await sql.NativeJmapDeleteFolder`DELETE FROM folders WHERE id=${ref.folderId} AND mailbox_id=${box.id}`;
			});
			destroyed.push(folderId);
		} catch (error) {
			notDestroyed[folderId] = {
				type: error instanceof JmapError ? error.type : "serverFail",
			};
		}
	}
	return {
		accountId: ctx.accountId,
		oldState,
		newState: await getMailboxState(ctx),
		created,
		updated,
		destroyed,
		notCreated,
		notUpdated,
		notDestroyed,
	};
};
export function pick(
	item: Record<string, unknown>,
	properties: string[] | null | undefined,
): Record<string, unknown> {
	if (!properties) return item;
	const result: Record<string, unknown> = { id: item.id };
	for (const key of properties) if (key in item) result[key] = item[key];
	return result;
}

export function ensureJmapError(error: unknown): never {
	if (error instanceof JmapError) throw error;
	throw error;
}
