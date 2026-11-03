import { z } from "zod";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
	prepareReadFixture,
	readActor,
	type ReadSample,
} from "./mail-read-fixture";
import { LocalStorage } from "../src/server/storage";
export type DetailSample = {
	name: string;
	endpoint: "detail" | "metadata" | "thread" | "attachment";
	id?: string;
	actor?: "owner" | "stranger";
	permission?: string;
	disabled?: boolean;
	personal?: boolean;
	variant?:
		| "no-raw"
		| "missing-raw"
		| "no-contacts"
		| "blank-contacts"
		| "empty-thread"
		| "large-thread"
		| "mixed-authors"
		| "multiple-jobs"
		| "no-unsubscribe"
		| "mailto-unsubscribe";
	attachment?: string;
	query?: string;
};
export const detailSamples: DetailSample[] = [];
for (const endpoint of ["detail", "metadata", "thread"] as const) {
	for (const id of [
		"in-a",
		"out-thread",
		"queued",
		"trash",
		"spam",
		"draft",
		"template",
		"orphan",
		"missing",
		"foreign",
	])
		detailSamples.push({ name: `${endpoint}-${id}`, endpoint, id });
	for (const variant of [
		"no-raw",
		"missing-raw",
		"no-contacts",
		"blank-contacts",
		"empty-thread",
		"multiple-jobs",
		"no-unsubscribe",
		"mailto-unsubscribe",
	] as const)
		detailSamples.push({ name: `${endpoint}-${variant}`, endpoint, variant });
	for (const permission of [
		"read_only",
		"send_on_behalf",
		"send_as",
		"full_access",
		"unknown",
	])
		detailSamples.push({
			name: `${endpoint}-shared-${permission}`,
			endpoint,
			actor: "stranger",
			permission,
		});
	detailSamples.push(
		{ name: `${endpoint}-disabled`, endpoint, disabled: true },
		{
			name: `${endpoint}-personal-denied`,
			endpoint,
			actor: "stranger",
			permission: "read_only",
			personal: true,
		},
	);
}
detailSamples.push(
	{ name: "thread-large", endpoint: "thread", variant: "large-thread" },
	{
		name: "thread-mixed-authors",
		endpoint: "thread",
		variant: "mixed-authors",
	},
);
for (const [attachment, query] of [
	["read-attachment", ""],
	["read-attachment", "preview=1"],
	["read-attachment", "inline=1"],
	["read-attachment", "download=1&preview=1"],
	["detail-image", ""],
	["detail-image", "download=1"],
	["detail-html", "preview=1"],
	["detail-svg", "preview=1"],
	["detail-pdf", "preview=1"],
	["detail-pdf", "download=1"],
	["detail-text", "preview=1"],
	["detail-audio", "preview=1"],
	["detail-unicode", ""],
	["detail-sanitized", ""],
	["detail-missing-object", ""],
	["detail-trashed", ""],
	["missing", ""],
	["read-inline", ""],
] as const)
	detailSamples.push({
		name: `attachment-${attachment}-${query || "default"}`,
		endpoint: "attachment",
		attachment,
		query,
	});
for (const permission of [
	"read_only",
	"send_on_behalf",
	"send_as",
	"full_access",
	"unknown",
])
	detailSamples.push({
		name: `attachment-shared-${permission}`,
		endpoint: "attachment",
		actor: "stranger",
		permission,
	});
detailSamples.push(
	{
		name: "attachment-orphan-owner",
		endpoint: "attachment",
		id: "orphan",
		attachment: "detail-orphan",
	},
	{
		name: "attachment-orphan-denied",
		endpoint: "attachment",
		id: "orphan",
		attachment: "detail-orphan",
		actor: "stranger",
	},
	{ name: "attachment-disabled", endpoint: "attachment", disabled: true },
	{
		name: "attachment-wrong-message",
		endpoint: "attachment",
		id: "out-thread",
	},
);
export const detailPath = (sample: DetailSample) =>
	`/api/messages/${sample.id ?? "in-a"}` +
	(sample.endpoint === "detail"
		? ""
		: sample.endpoint === "attachment"
			? `/attachments/${sample.attachment ?? "read-attachment"}`
			: `/${sample.endpoint}`) +
	(sample.query ? "?" + sample.query : "");
export const detailActor = (sample: DetailSample) =>
	readActor({ ...sample, kind: "list" } satisfies ReadSample);
export async function prepareDetailFixture(
	db: Database,
	directory: string,
	sample: DetailSample,
) {
	prepareReadFixture(db, { ...sample, kind: "list" });
	const storage = new LocalStorage(join(directory, "blobs"));
	await rm(join(directory, "blobs", "read"), { recursive: true, force: true });
	const raw =
		"From: Sender <sender@example.org>\r\nTo: Receiver <receiver@example.net>\r\nList-Unsubscribe: <mailto:leave@example.org>,\r\n <https://example.org/unsubscribe?token=synthetic>\r\n\r\nSynthetic raw body\r\n";
	await storage.put(
		"read/raw.eml",
		sample.variant === "no-unsubscribe"
			? "From: sender@example.org\r\n\r\nBody"
			: sample.variant === "mailto-unsubscribe"
				? "List-Unsubscribe: <mailto:leave@example.org>\r\n\r\nBody"
				: raw,
	);
	await storage.put("read/invoice", "hello");
	await storage.put("read/image", "image");
	db.exec(
		"UPDATE messages SET raw_r2_key='read/raw.eml',html_body='<p>Stored HTML &amp; body</p>',cc_addr='Copy <copy@example.net>',bcc_addr='Blind <blind@example.net>',reply_to='Reply <reply@example.org>',in_reply_to='<prior@example.org>',references_header='<first@example.org> <prior@example.org>'",
	);
	if (sample.variant === "no-raw")
		db.exec("UPDATE messages SET raw_r2_key=NULL");
	if (sample.variant === "missing-raw") await storage.delete("read/raw.eml");
	if (sample.variant === "no-contacts") db.exec("DELETE FROM contacts");
	else
		db.exec(
			"UPDATE contacts SET avatar_key='read/avatar.png' WHERE email='sender@example.org'",
		);
	if (sample.variant === "blank-contacts")
		db.exec("UPDATE contacts SET display_name=''");
	if (sample.variant === "empty-thread")
		db.exec("UPDATE messages SET thread_id='' WHERE id='in-a'");
	if (sample.variant === "mixed-authors")
		db.exec("UPDATE messages SET user_id='stranger' WHERE id='out-thread'");
	if (sample.variant === "multiple-jobs")
		db.exec(
			"INSERT INTO outbound_jobs(id,user_id,message_id,status,payload,scheduled_at,created_at,updated_at) VALUES('read-job-2','owner','queued','queued','{}',4102444900,2,2)",
		);
	if (sample.variant === "large-thread") {
		const insert = db.query(
			"INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,thread_id,created_at) VALUES(?,'owner','mailbox','inbound','sender@example.org','receiver@example.net','received','thread-one',?)",
		);
		db.transaction(() => {
			for (let i = 0; i < 205; i++) insert.run(`large-${i}`, 1800000000 + i);
		})();
	}
	const insert = db.query(
		"INSERT INTO message_attachments(id,message_id,filename,content_type,size,disposition,content_id,r2_key,created_at,trashed_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
	);
	for (const [id, filename, type, disposition] of [
		["image", "image.png", "image/png", "inline"],
		["html", "page.html", "text/html", "attachment"],
		["svg", "vector.svg", "image/svg+xml", "inline"],
		["pdf", "document.pdf", "application/pdf", "attachment"],
		["text", "note.txt", "text/plain; charset=utf-8", "attachment"],
		["audio", "sound.mp3", "audio/mpeg", "attachment"],
		["unicode", "café.txt", "text/plain", "attachment"],
		[
			"sanitized",
			'bad"\\\r\nname.txt',
			"application/octet-stream",
			"attachment",
		],
		["missing-object", "missing.txt", "text/plain", "attachment"],
		["trashed", "trashed.txt", "text/plain", "attachment"],
		["orphan", "orphan.txt", "text/plain", "attachment"],
	] as const) {
		const key = `read/detail-${id}`,
			bytes = `Synthetic ${id} bytes`;
		if (id !== "missing-object") await storage.put(key, bytes);
		insert.run(
			"detail-" + id,
			id === "orphan" ? "orphan" : "in-a",
			filename,
			type,
			Buffer.byteLength(bytes),
			disposition,
			disposition === "inline" ? id : null,
			key,
			2,
			id === "trashed" ? 123 : null,
		);
	}
}
export async function detailSnapshot(response: Response) {
	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("application/json"))
		return {
			status: response.status,
			body: (await response.json()) as unknown,
		};
	const bytes = await response.arrayBuffer();
	return {
		status: response.status,
		headers: Object.fromEntries(
			[
				"content-type",
				"content-disposition",
				"content-length",
				"cache-control",
				"x-content-type-options",
			].map((key) => [
				key,
				key === "content-length" && !response.ok
					? null
					: response.headers.get(key),
			]),
		),
		byteLength: bytes.byteLength,
		sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
	};
}

// Node emits UTF-8 bytes for legacy filename= while Bun exposes Latin-1 directly.
// Decode the source header once; keep the original captured header intact.
export function sourceComparableDetailSnapshot(value: unknown): unknown {
	const snapshot = z
		.object({ headers: z.record(z.string(), z.string().nullable()).optional() })
		.passthrough()
		.parse(value);
	const disposition = snapshot.headers?.["content-disposition"];
	if (!disposition || [...disposition].some((char) => char.charCodeAt(0) > 255))
		return snapshot;
	try {
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
			Uint8Array.from(disposition, (char) => char.charCodeAt(0)),
		);
		return {
			...snapshot,
			headers: { ...snapshot.headers, "content-disposition": decoded },
		};
	} catch {
		return snapshot;
	}
}
