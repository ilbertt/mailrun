import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { z } from "zod";
import {
	prepareSendFixture,
	sendMessageColumns,
} from "./send-contract-fixture";
import { restoreBackup } from "../src/lib/backups/export";
export const QUEUED_AT = Date.UTC(2030, 0, 1, 12),
	DUE_AT = QUEUED_AT + 3600_000,
	DELIVER_AT = DUE_AT + 1000;
export const QUEUE_ORIGIN = "https://queue-fixture.example";
export type QueueSample = {
	name: string;
	variant?: string;
	actor?: "owner" | "stranger";
	permission?: "send_as" | "send_on_behalf";
	alias?: boolean;
	personal?: boolean;
	fileSize?: number;
	disposition?: "inline" | "attachment";
	contentId?: string;
	threadId?: string;
	failure?: boolean;
	future?: boolean;
	dueOffset?: number;
	deliveryOffset?: number;
};
export const queueSamples: QueueSample[] = [
	{ name: "ordinary" },
	{ name: "millisecond-waits", dueOffset: 123, deliveryOffset: 50 },
	{ name: "millisecond-due", dueOffset: 123, deliveryOffset: 123 },
];
for (const variant of [
	"mailbox-renamed",
	"actor-renamed",
	"actor-disabled",
	"actor-demoted",
	"mailbox-disabled",
	"mailbox-owner-changed",
	"mailbox-deleted",
	"message-deleted",
	"message-draft",
	"job-deleted",
	"job-sent",
	"job-sending",
	"job-failed",
	"domain-disabled",
	"domain-inactive",
	"domain-none",
	"domain-deleted",
	"contact-renamed",
	"message-body-changed",
	"message-from-changed",
	"message-thread-changed",
])
	queueSamples.push({ name: variant, variant });
queueSamples.push(
	{
		name: "personal-profile-renamed",
		personal: true,
		variant: "actor-renamed",
	},
	{ name: "alias-removed", alias: true, variant: "alias-removed" },
	{ name: "alias-retargeted", alias: true, variant: "alias-retargeted" },
);
for (const permission of ["send_as", "send_on_behalf"] as const)
	for (const variant of [
		"grant-revoked",
		"grant-read-only",
		"actor-renamed",
		"license-expired",
	])
		queueSamples.push({
			name: permission + "-" + variant,
			actor: "stranger",
			permission,
			variant,
		});
queueSamples.push(
	{
		name: "explicit-thread-replaced",
		threadId: "submitted-thread",
		variant: "message-thread-changed",
	},
	{ name: "future-waits", future: true },
	{ name: "provider-failure", failure: true },
);
for (const [name, variant, size, disposition, contentId] of [
	["small-file", undefined, 6, "attachment", undefined],
	["inline-file", undefined, 6, "inline", "source-cid"],
	["inline-no-cid", undefined, 6, "inline", undefined],
	["attachment-with-cid", undefined, 6, "attachment", "ignored-cid"],
	["missing-file", "missing-file", 6, "attachment", undefined],
	["trashed-file", "trashed-file", 6, "attachment", undefined],
	["renamed-file", "renamed-file", 6, "attachment", undefined],
	["large-file", undefined, 3000001, "attachment", undefined],
	["large-wrong-size", "wrong-size", 3000001, "attachment", undefined],
	["small-wrong-size", "wrong-large-size", 6, "attachment", undefined],
	["link-reused", "valid-link", 3000001, "attachment", undefined],
	["link-expired", "expired-link", 3000001, "attachment", undefined],
	["large-provider-failure", undefined, 3000001, "attachment", undefined],
] as const)
	queueSamples.push({
		name,
		variant,
		fileSize: size,
		disposition,
		contentId,
		failure: name === "large-provider-failure",
	});
if (
	new Set(queueSamples.map((sample) => sample.name)).size !==
	queueSamples.length
)
	throw new Error("Duplicate queued-delivery case");
export const queueDeliveryTime = (sample: QueueSample) =>
	sample.deliveryOffset !== undefined
		? DUE_AT + sample.deliveryOffset
		: sample.future
			? DUE_AT - 1000
			: DELIVER_AT;
export function queuedInput(sample: QueueSample) {
	return {
		userId: sample.actor ?? "owner",
		mailboxId: "mailbox",
		from: sample.alias ? "named@example.com" : "hello@example.com",
		to: "Maya <maya@example.net>",
		cc: ["cc@example.net"],
		bcc: [],
		subject: "Queued source message",
		text: "Original body",
		html: "<p>Original body</p>",
		inReplyTo: "parent@example.net",
		references: ["<root@example.net>", "<parent@example.net>"],
		...(sample.threadId ? { threadId: sample.threadId } : {}),
		headers: { "X-Queue-Test": "original" },
		scheduledAt: new Date(DUE_AT + (sample.dueOffset ?? 0)).toISOString(),
		publicOrigin: QUEUE_ORIGIN,
	};
}
export async function prepareQueuedBase(
	db: Database,
	directory: string,
	sample: QueueSample,
) {
	db.exec(
		"PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;DELETE FROM routing_rules;DELETE FROM mailboxes WHERE id<>'mailbox';DELETE FROM domains WHERE id<>'domain'",
	);
	await prepareSendFixture(db, directory, {
		name: sample.name,
		kind: "send",
		permission: sample.permission,
	});
	db.exec(
		"DELETE FROM message_attachments;DELETE FROM outbound_jobs;DELETE FROM messages;UPDATE users SET name=CASE id WHEN 'owner' THEN 'Owner' ELSE 'Stranger' END,avatar_key=NULL;UPDATE users SET role='user',is_primary_admin=0 WHERE id='stranger';UPDATE mailboxes SET user_id='owner',local_part='hello',disabled=0,use_all_domains=0;UPDATE domains SET user_id='owner' WHERE id='domain';INSERT INTO mailboxes(id,user_id,domain_id,local_part,display_name,type,created_at) VALUES('other-box','stranger','domain','other','Other mailbox','personal',1)",
	);
	if (sample.alias)
		db.exec(
			"INSERT INTO mailbox_aliases(id,mailbox_id,domain_id,local_part,created_at) VALUES('named-alias','mailbox','domain','named',1)",
		);
	if (sample.personal)
		db.exec(
			"UPDATE mailboxes SET type='personal',display_name='Old primary label' WHERE id='mailbox'",
		);
}
export const queueIdentitySchema = z.object({
	messageId: z.string(),
	jobId: z.string(),
});
export type QueueIdentity = z.infer<typeof queueIdentitySchema>;
export function queuedChanges(sample: QueueSample, identity: QueueIdentity) {
	const actor = sample.actor ?? "owner",
		changes: { sql: string; args: (string | number | null)[] }[] = [];
	const add = (sql: string, ...args: (string | number | null)[]) =>
		changes.push({ sql, args });
	switch (sample.variant) {
		case "mailbox-renamed":
			add(
				"UPDATE mailboxes SET display_name='Changed mailbox' WHERE id='mailbox'",
			);
			break;
		case "actor-renamed":
			add("UPDATE users SET name='Changed account' WHERE id=?", actor);
			break;
		case "actor-disabled":
			add("UPDATE users SET disabled=1 WHERE id=?", actor);
			break;
		case "actor-demoted":
			add("UPDATE users SET role='user',is_primary_admin=0 WHERE id=?", actor);
			break;
		case "mailbox-disabled":
			add("UPDATE mailboxes SET disabled=1 WHERE id='mailbox'");
			break;
		case "mailbox-owner-changed":
			add("UPDATE mailboxes SET user_id='stranger' WHERE id='mailbox'");
			break;
		case "mailbox-deleted":
			add("DELETE FROM mailboxes WHERE id='mailbox'");
			break;
		case "message-deleted":
			add("DELETE FROM messages WHERE id=?", identity.messageId);
			break;
		case "message-draft":
			add("UPDATE messages SET status='draft' WHERE id=?", identity.messageId);
			break;
		case "job-deleted":
			add("DELETE FROM outbound_jobs WHERE id=?", identity.jobId);
			break;
		case "job-sent":
		case "job-sending":
		case "job-failed":
			add(
				"UPDATE outbound_jobs SET status=? WHERE id=?",
				sample.variant.slice(4),
				identity.jobId,
			);
			break;
		case "domain-disabled":
			add("UPDATE domains SET sending_enabled=0 WHERE id='domain'");
			break;
		case "domain-inactive":
			add("UPDATE domains SET status='pending' WHERE id='domain'");
			break;
		case "domain-none":
			add("UPDATE domains SET sending_provider='none' WHERE id='domain'");
			break;
		case "domain-deleted":
			add("DELETE FROM domains WHERE id='domain'");
			break;
		case "alias-removed":
			add("DELETE FROM mailbox_aliases WHERE id='named-alias'");
			break;
		case "alias-retargeted":
			add(
				"UPDATE mailbox_aliases SET mailbox_id='other-box' WHERE id='named-alias'",
			);
			break;
		case "grant-revoked":
			add(
				"DELETE FROM mailbox_access WHERE mailbox_id='mailbox' AND user_id=?",
				actor,
			);
			break;
		case "grant-read-only":
			add(
				"UPDATE mailbox_access SET permission='read_only' WHERE mailbox_id='mailbox' AND user_id=?",
				actor,
			);
			break;
		case "license-expired":
			add("UPDATE license_settings SET state='expired'");
			break;
		case "contact-renamed":
			add(
				"UPDATE contacts SET display_name='Manual after queue',source='manual',last_seen_at=123 WHERE user_id=? AND email='maya@example.net'",
				actor,
			);
			break;
		case "message-body-changed":
			add(
				"UPDATE messages SET text_body='Edited stored body',html_body='<p>Edited</p>',snippet='Edited snippet',subject='Edited subject' WHERE id=?",
				identity.messageId,
			);
			break;
		case "message-from-changed":
			add(
				"UPDATE messages SET from_addr='changed@example.net' WHERE id=?",
				identity.messageId,
			);
			break;
		case "message-thread-changed":
			add(
				"UPDATE messages SET thread_id='edited-thread' WHERE id=?",
				identity.messageId,
			);
			break;
		case "trashed-file":
			add(
				"UPDATE message_attachments SET trashed_at=? WHERE message_id=?",
				DELIVER_AT / 1000,
				identity.messageId,
			);
			break;
		case "renamed-file":
			add(
				"UPDATE message_attachments SET filename='Changed filename.txt',content_type='application/octet-stream' WHERE message_id=?",
				identity.messageId,
			);
			break;
		case "wrong-size":
			add(
				"UPDATE message_attachments SET size=1 WHERE message_id=?",
				identity.messageId,
			);
			break;
		case "wrong-large-size":
			add(
				"UPDATE message_attachments SET size=4000000 WHERE message_id=?",
				identity.messageId,
			);
			break;
		case "valid-link":
		case "expired-link":
			add(
				"INSERT INTO shared_attachment_links(id,attachment_id,expires_at,created_at) SELECT 'existing-share',id,?,? FROM message_attachments WHERE message_id=?",
				DELIVER_AT / 1000 + (sample.variant === "valid-link" ? 3600 : -1),
				QUEUED_AT / 1000,
				identity.messageId,
			);
			break;
	}
	return changes;
}
export async function applyQueuedChanges(
	db: Database,
	directory: string,
	sample: QueueSample,
	identity: QueueIdentity,
) {
	for (const change of queuedChanges(sample, identity))
		db.query(change.sql).run(...change.args);
	if (sample.variant === "missing-file") {
		const rows = z
			.array(z.object({ r2_key: z.string() }))
			.parse(
				db
					.query("SELECT r2_key FROM message_attachments WHERE message_id=?")
					.all(identity.messageId),
			);
		for (const row of rows)
			await rm(join(directory, "blobs", row.r2_key), { force: true });
	}
}
export const capturedObjectSchema = z.object({
	key: z.string(),
	size: z.number(),
	sha256: z.string(),
	base64: z.string().optional(),
	fill: z.number().optional(),
});
export const queuedBeforeSchema = z.object({
	backup: z.unknown(),
	identity: queueIdentitySchema,
	objects: z.array(capturedObjectSchema),
});
export async function restoreQueuedBefore(
	db: Database,
	directory: string,
	before: unknown,
) {
	const parsed = queuedBeforeSchema.parse(before);
	restoreBackup(db, parsed.backup);
	await rm(join(directory, "blobs"), { recursive: true, force: true });
	await mkdir(join(directory, "blobs"), { recursive: true });
	for (const object of parsed.objects) {
		const bytes =
			object.base64 !== undefined
				? Buffer.from(object.base64, "base64")
				: Buffer.alloc(object.size, object.fill ?? 81);
		if (
			new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !==
			object.sha256
		)
			throw new Error("Source queue object hash mismatch");
		await Bun.write(join(directory, "blobs", object.key), bytes);
	}
	if (
		db
			.query("SELECT name FROM sqlite_master WHERE name='mailrun_installation'")
			.get()
	)
		db.exec(
			"INSERT INTO mailrun_installation(id,account_id,zone_id,hostname,worker_name,public_origin,api_token,relay_secret,relay_version,phase,updated_at) VALUES('primary','account','zone','example.com','fixture','https://queue-fixture.example','synthetic-token','synthetic-secret','fixture','ready',1) ON CONFLICT(id) DO NOTHING",
		);
	return parsed.identity;
}
export async function queuedSnapshot(
	db: Database,
	directory: string,
	response: Response,
	deliveries: unknown[],
	identity: QueueIdentity,
) {
	const links = z
			.array(z.object({ id: z.string() }))
			.parse(
				db.query("SELECT id FROM shared_attachment_links ORDER BY rowid").all(),
			),
		audits = z
			.array(z.object({ id: z.string() }))
			.parse(db.query("SELECT id FROM audit_logs ORDER BY rowid").all());
	const ids = new Map<string, string>([
		[identity.messageId, "$message"],
		[identity.jobId, "$job"],
	]);
	let n = 0;
	for (const row of links)
		if (row.id !== "existing-share") ids.set(row.id, "$share-" + ++n);
	n = 0;
	for (const row of audits) ids.set(row.id, "$audit-" + ++n);
	const objects = [];
	for await (const key of new Bun.Glob("**/*").scan({
		cwd: join(directory, "blobs"),
		onlyFiles: true,
		dot: true,
	}))
		if (!key.endsWith(".meta.json"))
			objects.push({
				key,
				size: Bun.file(join(directory, "blobs", key)).size,
				sha256: new Bun.CryptoHasher("sha256")
					.update(await Bun.file(join(directory, "blobs", key)).bytes())
					.digest("hex"),
			});
	function norm(value: unknown, key = ""): unknown {
		if (typeof value === "string") {
			if (
				key === "error" &&
				(value.includes('Failed query: insert into "audit_logs"') ||
					value.includes("FOREIGN KEY constraint failed"))
			)
				return "$post-send-audit-foreign-key";
			let text = value;
			for (const [id, replacement] of ids)
				text = text.replaceAll(id, replacement);
			if (key === "payload" || key === "metadata")
				return norm(JSON.parse(text));
			return text;
		}
		if (Array.isArray(value)) return value.map((v) => norm(v));
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([k, v]) => [k, norm(v, k)]),
			);
		return value;
	}
	function wire(value: unknown): unknown {
		const mail = z
			.object({
				attachments: z
					.array(z.object({ content: z.string() }).passthrough())
					.optional(),
			})
			.passthrough()
			.parse(value);
		return {
			...mail,
			...(mail.attachments
				? {
						attachments: mail.attachments.map((file) => {
							const bytes = Buffer.from(file.content, "base64");
							return {
								...file,
								content: {
									size: bytes.byteLength,
									sha256: new Bun.CryptoHasher("sha256")
										.update(bytes)
										.digest("hex"),
								},
							};
						}),
					}
				: {}),
		};
	}
	return norm({
		status: response.status,
		body: await response.json(),
		messages: db
			.query("SELECT " + sendMessageColumns + " FROM messages ORDER BY rowid")
			.all(),
		jobs: db.query("SELECT * FROM outbound_jobs ORDER BY rowid").all(),
		files: db.query("SELECT * FROM message_attachments ORDER BY rowid").all(),
		contacts: db.query("SELECT * FROM contacts ORDER BY user_id,email").all(),
		audits: db.query("SELECT * FROM audit_logs ORDER BY rowid").all(),
		links: db
			.query("SELECT * FROM shared_attachment_links ORDER BY rowid")
			.all(),
		deliveries: deliveries.map(wire),
		objects: objects.sort((a, b) => a.key.localeCompare(b.key)),
	});
}
