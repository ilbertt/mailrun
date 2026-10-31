import type { Database } from "bun:sqlite";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

export type BulkSample = {
	name: string;
	kind: "bulk" | "empty" | "folders";
	actor: "owner" | "stranger";
	method?: "GET" | "POST";
	payload?: Record<string, unknown>;
	query?: string;
	rawBody?: string;
	permission?: string;
	status?: string;
	direction?: string;
	team?: boolean;
	personal?: boolean;
	disabled?: number;
	objects?: boolean;
	batch?: number;
	aggregate?: boolean;
	manyIds?: number;
};
export const bulkSamples: BulkSample[] = [];
for (const role of [
	"owner",
	"read_only",
	"send_on_behalf",
	"send_as",
	"full_access",
	"unshared",
])
	for (const action of [
		"archive",
		"trash",
		"spam",
		"read",
		"unread",
		"inbox",
		"folder",
		"delete",
	])
		bulkSamples.push({
			name: `${role}-${action}`,
			kind: "bulk",
			actor: role === "owner" ? "owner" : "stranger",
			permission: ["owner", "unshared"].includes(role) ? undefined : role,
			payload: {
				messageIds: ["message"],
				action,
				...(action === "folder" ? { folderId: "target-folder" } : {}),
			},
		});
bulkSamples.push(
	{
		name: "trash-again",
		kind: "bulk",
		actor: "owner",
		status: "trash",
		payload: { messageIds: ["message"], action: "trash" },
	},
	{
		name: "spam-to-inbox",
		kind: "bulk",
		actor: "owner",
		status: "spam",
		payload: { messageIds: ["message"], action: "inbox" },
	},
	{
		name: "outbound-spam",
		kind: "bulk",
		actor: "owner",
		status: "sent",
		direction: "outbound",
		payload: { messageIds: ["message"], action: "spam" },
	},
	{
		name: "trash-delete-with-objects",
		kind: "bulk",
		actor: "owner",
		status: "trash",
		objects: true,
		payload: { messageIds: ["message"], action: "delete" },
	},
	{
		name: "live-delete-preserves-objects",
		kind: "bulk",
		actor: "owner",
		objects: true,
		payload: { messageIds: ["message"], action: "delete" },
	},
	{
		name: "mixed-access",
		kind: "bulk",
		actor: "owner",
		payload: {
			messageIds: ["message", "bulk-foreign-message"],
			action: "read",
		},
	},
	{
		name: "duplicate-and-empty-ids",
		kind: "bulk",
		actor: "owner",
		payload: {
			messageIds: ["message", "", null, false, "message"],
			action: "read",
		},
	},
	{
		name: "missing-ids",
		kind: "bulk",
		actor: "owner",
		payload: { messageIds: [], action: "read" },
	},
	{
		name: "invalid-action",
		kind: "bulk",
		actor: "owner",
		payload: { messageIds: ["message"], action: "unknown" },
	},
	{
		name: "folder-required",
		kind: "bulk",
		actor: "owner",
		payload: { messageIds: ["message"], action: "folder" },
	},
	{
		name: "folder-missing",
		kind: "bulk",
		actor: "owner",
		payload: { messageIds: ["message"], action: "folder", folderId: "missing" },
	},
	{
		name: "invalid-read-grant",
		kind: "bulk",
		actor: "stranger",
		permission: "unknown",
		payload: { messageIds: ["message"], action: "read" },
	},
	{
		name: "many-duplicate-ids",
		kind: "bulk",
		actor: "owner",
		manyIds: 10001,
		payload: { messageIds: ["message"], action: "read" },
	},
);
for (const role of ["owner", "read_only", "full_access", "unshared"])
	bulkSamples.push({
		name: `${role}-empty-trash`,
		kind: "empty",
		actor: role === "owner" ? "owner" : "stranger",
		permission: ["owner", "unshared"].includes(role) ? undefined : role,
		status: "trash",
		objects: true,
		payload: { mailboxId: "mailbox", folder: "trash" },
	});
bulkSamples.push(
	{
		name: "empty-spam",
		kind: "empty",
		actor: "owner",
		status: "spam",
		objects: true,
		payload: { mailboxId: "mailbox", folder: "spam" },
	},
	{
		name: "empty-invalid-folder",
		kind: "empty",
		actor: "owner",
		payload: { mailboxId: "mailbox", folder: "inbox" },
	},
	{
		name: "empty-malformed-json",
		kind: "empty",
		actor: "owner",
		rawBody: "not JSON",
	},
	{
		name: "empty-batch-101",
		kind: "empty",
		actor: "owner",
		batch: 101,
		aggregate: true,
		payload: { mailboxId: "mailbox", folder: "trash" },
	},
);
for (const role of ["owner", "read_only", "full_access", "unshared", "unknown"])
	for (const method of ["GET", "POST"] as const)
		bulkSamples.push({
			name: `${role}-folders-${method.toLowerCase()}`,
			kind: "folders",
			actor: role === "owner" ? "owner" : "stranger",
			permission: ["owner", "unshared"].includes(role) ? undefined : role,
			method,
			query: method === "GET" ? "?mailboxId=mailbox" : undefined,
			payload:
				method === "POST"
					? { mailboxId: "mailbox", name: "New folder" }
					: undefined,
		});
bulkSamples.push(
	{
		name: "folders-no-mailbox",
		kind: "folders",
		actor: "owner",
		method: "GET",
	},
	{
		name: "folder-name-81",
		kind: "folders",
		actor: "owner",
		payload: { mailboxId: "mailbox", name: "x".repeat(81) },
	},
	{
		name: "folder-invalid-color",
		kind: "folders",
		actor: "owner",
		payload: { mailboxId: "mailbox", name: "Color", color: "red" },
	},
	{
		name: "folder-duplicate",
		kind: "folders",
		actor: "owner",
		payload: { mailboxId: "mailbox", name: "Alpha" },
	},
	{
		name: "folder-trim-and-color",
		kind: "folders",
		actor: "owner",
		payload: { mailboxId: "mailbox", name: "  Trimmed  ", color: "#db2777" },
	},
);

export function bulkPayload(sample: BulkSample) {
	return sample.manyIds
		? {
				...sample.payload,
				messageIds: Array.from({ length: sample.manyIds }, () => "message"),
			}
		: sample.payload;
}
export function bulkPath(sample: BulkSample) {
	return (
		(sample.kind === "folders"
			? "/api/folders"
			: `/api/messages/${sample.kind}`) + (sample.query ?? "")
	);
}
export async function prepareBulkFixture(
	db: Database,
	directory: string,
	sample: BulkSample,
) {
	db.exec(
		"PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; DELETE FROM audit_logs; DELETE FROM spam_feedback; DELETE FROM spam_token_stats; DELETE FROM spam_reputation; DELETE FROM mailbox_access; DELETE FROM messages WHERE id='message' OR id='bulk-foreign-message' OR id LIKE 'bulk-case-%'; DELETE FROM folders WHERE id LIKE 'created-%' OR id NOT IN('start-folder','target-folder'); INSERT OR IGNORE INTO mailboxes(id,user_id,domain_id,local_part,created_at) VALUES('bulk-foreign-mailbox','stranger','domain','bulk-other',1); INSERT INTO license_settings(id,instance_id,plan,state,updated_at) VALUES('default','fixture','team','active',1) ON CONFLICT(id) DO UPDATE SET plan='team',state='active'; INSERT OR IGNORE INTO folders(id,user_id,mailbox_id,name,color,created_at) VALUES('start-folder','owner','mailbox','Zulu','#7c3aed',1); INSERT OR IGNORE INTO folders(id,user_id,mailbox_id,name,color,created_at) VALUES('target-folder','owner','mailbox','Alpha','#2563eb',2)",
	);
	db.query("UPDATE mailboxes SET type=?,disabled=? WHERE id='mailbox'").run(
		sample.personal ? "personal" : "shared",
		sample.disabled ?? 0,
	);
	if (sample.team === false)
		db.exec("UPDATE license_settings SET plan='free' WHERE id='default'");
	if (sample.permission)
		db.query(
			"INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES('bulk-share','mailbox','stranger',?,1)",
		).run(sample.permission);
	const insert = db.query(
		"INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,text_body,status,folder_id,snoozed_until,read,starred,created_at,raw_r2_key) VALUES(?,?,?,?, 'sender@example.org','hello@example.com','Bulk subject','Body to preserve',?,'start-folder',4000000000,0,1,?,?)",
	);
	insert.run(
		"message",
		"owner",
		"mailbox",
		sample.direction ?? "inbound",
		sample.status ?? "received",
		1,
		sample.objects ? "bulk-contract/raw.eml" : null,
	);
	insert.run(
		"bulk-foreign-message",
		"stranger",
		"bulk-foreign-mailbox",
		"inbound",
		"received",
		1,
		null,
	);
	db.exec("UPDATE messages SET folder_id=NULL WHERE id='bulk-foreign-message'");
	for (let i = 0; i < (sample.batch ?? 0); i++)
		insert.run(
			`bulk-case-${String(i).padStart(3, "0")}`,
			"owner",
			"mailbox",
			"inbound",
			"trash",
			i + 10,
			null,
		);
	db.exec(
		"UPDATE messages SET trashed_at=123 WHERE id='message' OR id LIKE 'bulk-case-%'",
	);
	const root = join(directory, "blobs/bulk-contract");
	await rm(root, { recursive: true, force: true });
	if (sample.objects) {
		await mkdir(root, { recursive: true, mode: 0o700 });
		await Bun.write(join(root, "raw.eml"), "Synthetic raw MIME", {
			mode: 0o600,
		});
		await Bun.write(join(root, "attachment.bin"), "Synthetic attachment", {
			mode: 0o600,
		});
		db.exec(
			"INSERT INTO message_attachments(id,message_id,filename,content_type,size,r2_key,created_at) VALUES('bulk-attachment','message','attachment.bin','application/octet-stream',20,'bulk-contract/attachment.bin',1); INSERT INTO shared_attachment_links(id,attachment_id,expires_at,created_at) VALUES('bulk-link','bulk-attachment',9999999999,1)",
		);
	}
}

export async function bulkSnapshot(
	db: Database,
	directory: string,
	sample: BulkSample,
	response: unknown,
	started: number,
) {
	const body =
		response && typeof response === "object"
			? ({ ...response } as Record<string, unknown>)
			: response;
	const createdId =
		sample.kind === "folders" &&
		sample.method !== "GET" &&
		body &&
		typeof body === "object" &&
		"id" in body &&
		typeof body.id === "string"
			? body.id
			: undefined;
	if (createdId && body && typeof body === "object" && "id" in body)
		body.id = "<created>";
	const messages = db
		.query(
			"SELECT id,status,folder_id,snoozed_until,trashed_at,read,starred FROM messages WHERE id='message' OR id='bulk-foreign-message' OR id LIKE 'bulk-case-%' ORDER BY id",
		)
		.all()
		.map((row) => {
			const value = row as Record<string, unknown>;
			if (
				typeof value.trashed_at === "number" &&
				value.trashed_at >= started &&
				value.trashed_at <= Math.floor(Date.now() / 1000)
			)
				value.trashed_at = "now";
			return value;
		});
	const audit = db
		.query("SELECT action,mailbox_id,message_id,metadata FROM audit_logs")
		.all()
		.map((row) => {
			const value = row as {
				action: string;
				mailbox_id: string | null;
				message_id: string | null;
				metadata: string | null;
			};
			const metadata = value.metadata
				? (JSON.parse(value.metadata) as Record<string, unknown>)
				: null;
			if (sample.aggregate && metadata) delete metadata.messageId;
			return {
				action: value.action,
				mailboxId: value.mailbox_id,
				messageId: value.message_id,
				metadata,
			};
		})
		.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	const folders = db
		.query(
			"SELECT id,user_id,mailbox_id,name,color,created_at FROM folders WHERE mailbox_id='mailbox' ORDER BY name,id",
		)
		.all()
		.map((row) => {
			const value = row as Record<string, unknown>;
			if (value.id === createdId) {
				value.id = "<created>";
				if (
					typeof value.created_at === "number" &&
					value.created_at >= started &&
					value.created_at <= Math.floor(Date.now() / 1000)
				)
					value.created_at = "now";
			}
			return value;
		});
	const objects: Record<string, string | null> = {};
	if (sample.objects)
		for (const key of ["raw.eml", "attachment.bin"]) {
			const file = Bun.file(join(directory, "blobs/bulk-contract", key));
			objects[key] = (await file.exists())
				? new Bun.CryptoHasher("sha256")
						.update(await file.arrayBuffer())
						.digest("hex")
				: null;
		}
	const counts = Object.fromEntries(
		Object.entries(
			messages.reduce<Record<string, number>>((result, message) => {
				const status = String(message.status);
				result[status] = (result[status] ?? 0) + 1;
				return result;
			}, {}),
		).sort(),
	);
	return {
		body,
		messages: sample.aggregate ? counts : messages,
		audit,
		folders,
		objects,
		attachments: db
			.query(
				"SELECT id,message_id,r2_key FROM message_attachments WHERE id='bulk-attachment'",
			)
			.all(),
		links: db
			.query(
				"SELECT id,attachment_id FROM shared_attachment_links WHERE id='bulk-link'",
			)
			.all(),
		feedback: db
			.query(
				"SELECT message_id,classification FROM spam_feedback ORDER BY message_id",
			)
			.all(),
	};
}
