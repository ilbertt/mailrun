import { lstatSync, opendirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type {
	DatabaseRecord,
	DatabaseBackupTable,
} from "../../lib/backups/types";
import { parseBackupDocument } from "../../lib/backups/export";
import type { AppSQL } from "../db";
import { dataDirectory } from "../config";
import { LocalStorage } from "../storage";

const sha = (value: string) =>
	new Bun.CryptoHasher("sha256").update(value).digest("hex");
export const sourceDriveUploadId = (itemId: string, sourceId: string) =>
	"local_migrated_" + sha(itemId + "\0" + sourceId);
export const sourceDriveMetadataKey = (itemId: string, sourceId: string) =>
	`drive-uploads/${encodeURIComponent(itemId)}/${sourceDriveUploadId(itemId, sourceId)}/source.json`;
export const sourceDriveMetadataSchema = z.object({
	format: z.literal("mailrun-source-drive-upload"),
	version: z.literal(1),
	itemId: z.string(),
	ownerId: z.string(),
	sourceId: z.string(),
	size: z.number().int().nonnegative(),
	partSize: z.number().int().positive(),
	r2Key: z.string().nullable(),
	parts: z.array(
		z.object({
			number: z.number().int().positive(),
			sourceEtag: z.string(),
			sha256: z.string().regex(/^[a-f0-9]{64}$/),
		}),
	),
});
const uploadSchema = z.object({
	id: z.string(),
	user_id: z.string(),
	r2_key: z.string(),
	content_type: z.string(),
	name: z.string().nullable(),
	size: z.number().int().nonnegative(),
	created_at: z.number().int(),
});
const metadataKey = (user: string, id: string) =>
	`jmap/${sha(user)}/${sha(id)}.json`;
const missing = (error: unknown) =>
	error instanceof Error && "code" in error && error.code === "ENOENT";

// Original JMAP metadata lives beside objects, outside the source DB backup.
// Keep equivalent per-object metadata so legacy restores do not discard uploads.
async function snapshotUploadMetadata(
	sql: AppSQL,
	objects: LocalStorage,
	metadata: LocalStorage,
) {
	let cursor: string | null = null;
	for (;;) {
		const rows: z.infer<typeof uploadSchema>[] =
			await sql.NativeRestoreUploadMetadataPage`SELECT * FROM mailrun_jmap_uploads WHERE (${cursor} IS NULL OR id>${cursor}) ORDER BY id LIMIT 500`;
		for (const row of rows) {
			const value = uploadSchema.parse(row);
			if (value.r2_key !== `jmap-uploads/${value.user_id}/${value.id}`)
				throw new Error("Invalid upload object namespace");
			const file = objects.file(value.r2_key);
			if (await file.exists())
				await metadata.put(
					metadataKey(value.user_id, value.id),
					JSON.stringify(value),
				);
		}
		if (rows.length < 500) return;
		cursor = rows.at(-1)?.id ?? null;
		if (cursor === null) throw new Error("Invalid upload metadata page");
	}
}
function* uploadedObjects(
	users: DatabaseRecord[],
	objects: LocalStorage,
	metadata: LocalStorage,
): Generator<DatabaseRecord> {
	for (const user of users) {
		if (typeof user.id !== "string") continue;
		const directory = metadata.path(`jmap/${sha(user.id)}`);
		let entries: ReturnType<typeof opendirSync>;
		try {
			entries = opendirSync(directory);
		} catch (error) {
			if (missing(error)) continue;
			throw error;
		}
		try {
			let entry: ReturnType<typeof entries.readSync>;
			while ((entry = entries.readSync())) {
				if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
				const path = join(directory, entry.name),
					info = lstatSync(path);
				if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
					throw new Error("Invalid upload object metadata");
				const row = uploadSchema.parse(JSON.parse(readFileSync(path, "utf8")));
				if (
					row.user_id !== user.id ||
					row.r2_key !== `jmap-uploads/${row.user_id}/${row.id}` ||
					entry.name !== sha(row.id) + ".json"
				)
					throw new Error("Invalid upload object namespace");
				try {
					const file = lstatSync(objects.path(row.r2_key));
					if (file.isFile() && !file.isSymbolicLink() && file.size === row.size)
						yield row;
				} catch (error) {
					if (!missing(error)) throw error;
				}
			}
		} finally {
			entries.closeSync();
		}
	}
}
export async function prepareObjectRestore(sql: AppSQL, input: unknown) {
	const document = parseBackupDocument(input),
		objects = new LocalStorage(),
		metadata = new LocalStorage(
			join(dataDirectory(), "restore-object-metadata"),
		);

	const missingTableRows: Partial<
		Record<DatabaseBackupTable, () => Iterable<DatabaseRecord>>
	> = {};
	const legacyInstallation = !Object.hasOwn(
		document.tables,
		"mailrun_installation",
	);
	const currentInstallation = legacyInstallation
		? (
				await sql.NativeRestoreCurrentInstallation`SELECT * FROM mailrun_installation WHERE id='primary'`
			).map((row) => ({ ...row }))
		: [];
	if (legacyInstallation)
		missingTableRows.mailrun_installation = () => currentInstallation;
	const installation = (
		document.tables.mailrun_installation ?? currentInstallation
	).find((row) => row.id === "primary");
	for (const domain of document.tables.domains ?? []) {
		if (
			typeof domain.id !== "string" ||
			Object.hasOwn(domain, "mailrun_relay_worker_name") ||
			Object.hasOwn(domain, "mailrun_relay_zone_id")
		)
			continue;
		if (installation?.phase !== "ready") continue;
		let verified = false;
		if (legacyInstallation) {
			const [current] =
				await sql.NativeRestoreCurrentRelayBinding`SELECT user_id,hostname,zone_id,mailrun_relay_worker_name,mailrun_relay_zone_id FROM domains WHERE id=${domain.id}`;
			verified =
				!!current &&
				current.user_id === domain.user_id &&
				current.hostname === domain.hostname &&
				current.zone_id === domain.zone_id &&
				current.mailrun_relay_zone_id === domain.zone_id &&
				current.mailrun_relay_worker_name === installation.worker_name;
		}
		if (
			verified ||
			(domain.routing_enabled === 1 &&
				domain.hostname === installation.hostname &&
				domain.zone_id === installation.zone_id)
		) {
			domain.mailrun_relay_worker_name = installation.worker_name ?? null;
			domain.mailrun_relay_zone_id = domain.zone_id ?? null;
		}
	}
	const legacyUploads = !Object.hasOwn(document.tables, "mailrun_jmap_uploads");
	if (legacyUploads) await snapshotUploadMetadata(sql, objects, metadata);
	for (const item of document.tables.drive_items ?? []) {
		if (typeof item.id !== "string" || typeof item.upload_id !== "string")
			continue;
		const file = objects.file(sourceDriveMetadataKey(item.id, item.upload_id));
		if (!(await file.exists())) continue;
		if (file.size > 4 * 1024 * 1024)
			throw new Error("Source Drive mapping is too large");
		const mapping = sourceDriveMetadataSchema.parse(await file.json());
		if (
			mapping.itemId !== item.id ||
			mapping.sourceId !== item.upload_id ||
			mapping.ownerId !== item.owner_id ||
			mapping.size !== item.size ||
			mapping.partSize !== item.upload_part_size ||
			mapping.r2Key !== item.r2_key
		)
			throw new Error("Source Drive backup does not match the migrated upload");
		for (const part of document.tables.drive_upload_parts ?? []) {
			if (part.item_id !== item.id) continue;
			const known = mapping.parts.find(
				(value) => value.number === part.part_number,
			);
			if (!known || part.etag !== known.sourceEtag)
				throw new Error(
					"Source Drive backup refers to parts that were not migrated",
				);
			part.etag = known.sha256;
		}
		item.upload_id = sourceDriveUploadId(mapping.itemId, mapping.sourceId);
	}

	if (legacyUploads)
		missingTableRows.mailrun_jmap_uploads = () =>
			uploadedObjects(document.tables.users ?? [], objects, metadata);
	return { document, missingTableRows };
}
