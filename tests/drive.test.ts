import * as driveFiles from "../src/server/drive/files";
import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { join } from "node:path";
import { fixture, owner, stranger, enableTeamSharing } from "./fixtures";
import {
	listDrive,
	createDriveFolder,
	listDriveFolders,
} from "../src/server/drive/listing";
import {
	patchDriveItem,
	deleteDriveItem,
	bulkDriveItems,
} from "../src/server/drive/mutations";
import {
	shareDriveItem,
	getDriveShares,
	revokeDriveShare,
	linkDriveItem,
	publicDriveApi,
} from "../src/server/drive/sharing";
import {
	startUpload,
	uploadPart,
	finishUpload,
	abortUpload,
} from "../src/server/drive/uploads";
import { streamDriveFile, parseByteRange } from "../src/server/drive/content";
import {
	clearDriveRuntimeLeases,
	partKey,
	driveLock,
} from "../src/server/drive/files";
import { driveRow } from "../src/server/drive/repository";
import {
	driveAttachment,
	changeDriveAttachments,
} from "../src/server/drive/attachments";
import {
	runDriveRetention,
	cleanupStaleDriveUploads,
} from "../src/server/drive/retention";
import { LocalStorage } from "../src/server/storage";
import { writeBackup, restoreBackup } from "../src/lib/backups/export";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
const listing = (params = "") => listDrive(owner, new URLSearchParams(params));
async function pending(
	name = "notes.txt",
	parentId: string | null = null,
	size = 8,
	user = owner,
) {
	const result = await startUpload(user, {
		name,
		size,
		parentId,
		fingerprint: "1234",
		contentType: "text/plain",
	});
	if (!("id" in result)) throw new Error("Expected pending upload");
	state.db
		.query("UPDATE drive_items SET upload_part_size=4 WHERE id=?")
		.run(result.id);
	return result.id;
}
const put = (
	itemId: string,
	part: number,
	text: string,
	user = owner,
	length = new TextEncoder().encode(text).length,
) =>
	uploadPart(
		user,
		itemId,
		part,
		new Request("http://localhost/", {
			method: "PUT",
			headers: { "Content-Length": String(length) },
			body: text,
		}),
	);
async function file(
	name = "notes.txt",
	parentId: string | null = null,
	user = owner,
) {
	const itemId = await pending(name, parentId, 8, user);
	await put(itemId, 1, "abcd", user);
	await put(itemId, 2, "efgh", user);
	return (await finishUpload(user, itemId)).item!;
}
const stored = (itemId: string) =>
	driveRow(state.db.query("SELECT * FROM drive_items WHERE id=?").get(itemId));
async function publicResponse(token: string, itemId?: string, content = false) {
	const response = await publicDriveApi(
		new Request(
			`http://localhost/api/drive/public/${token}?${new URLSearchParams({ ...(itemId ? { item: itemId } : {}), ...(content ? { content: "1" } : {}) })}`,
		),
	);
	if (!response) throw new Error("Missing response");
	return response;
}
test("original listing contract, literal searches, categories and complete owned folders", async () => {
	const parent = (await createDriveFolder(owner, { name: "Project" })).item!;
	const child = await file("Research_100%.PDF", parent.id);
	expect((await listing()).items.map((item) => item.name)).toEqual(["Project"]);
	expect(await listing("parent=" + parent.id)).toMatchObject({
		role: "owner",
		path: [{ id: parent.id, name: "Project" }],
		storageUsed: 8,
		storageLimit: null,
	});
	expect((await listing("q=100%25")).items[0]?.id).toBe(child.id);
	expect((await listing("q=ResearchX100")).items).toEqual([]);
	expect(
		(await listing("types=documents")).items.map((item) => item.id),
	).toEqual([child.id]);
	expect((await listing("types=photos")).items).toEqual([]);
	expect((await listDriveFolders(owner)).folders).toEqual([
		{ id: parent.id, name: "Project", parentId: null },
	]);
	await patchDriveItem(owner, parent.id, { trashed: true });
	expect((await listing("q=Research")).items).toEqual([]);
	expect((await listDriveFolders(owner)).folders).toEqual([]);
	expect((await listing("view=trash")).items.map((item) => item.id)).toEqual([
		parent.id,
	]);
	await patchDriveItem(owner, parent.id, { trashed: false });
	expect((await listing("q=Research")).items).toHaveLength(1);
});
test("inherited share roles, owner quota and revocation across all access paths", async () => {
	const hidden = (await createDriveFolder(owner, { name: "Private ancestor" }))
			.item!,
		parent = (
			await createDriveFolder(owner, { name: "Shared", parentId: hidden.id })
		).item!;
	await shareDriveItem(owner, parent.id, stranger.email, "view");
	const shared = await listDrive(
		stranger,
		new URLSearchParams("parent=" + parent.id),
	);
	expect(shared.path).toEqual([{ id: parent.id, name: "Shared" }]);
	expect(shared.role).toBe("view");
	await expect(
		createDriveFolder(stranger, { name: "Denied", parentId: parent.id }),
	).rejects.toMatchObject({ status: 404 });
	const shares = await shareDriveItem(owner, parent.id, stranger.email, "edit");
	expect(shares.shares).toHaveLength(1);
	const child = await file("Shared notes", parent.id, stranger);
	expect(child).toMatchObject({ ownerId: owner.id, role: "edit" });
	expect((await listing()).storageUsed).toBe(8);
	expect((await listDrive(stranger, new URLSearchParams())).storageUsed).toBe(
		0,
	);
	await expect(
		patchDriveItem(stranger, child.id, { trashed: false }),
	).rejects.toMatchObject({ status: 403 });
	await patchDriveItem(stranger, child.id, { name: "Edited" });
	await revokeDriveShare(owner, parent.id, shares.shares[0]!.id);
	await expect(
		listDrive(stranger, new URLSearchParams("parent=" + parent.id)),
	).rejects.toMatchObject({ status: 404 });
	await expect(getDriveShares(stranger, parent.id)).rejects.toMatchObject({
		status: 404,
	});
	await expect(
		patchDriveItem(stranger, child.id, { name: "Stolen" }),
	).rejects.toMatchObject({ status: 404 });
});
test("quota reservations serialize concurrent uploads, include trash and recover stale legacy uploads", async () => {
	state.db.exec(
		"UPDATE app_settings SET drive_storage_limit_bytes=10 WHERE id='default'",
	);
	const attempts = await Promise.allSettled([pending("one"), pending("two")]);
	expect(
		attempts.filter((result) => result.status === "fulfilled"),
	).toHaveLength(1);
	expect(
		attempts.filter((result) => result.status === "rejected")[0],
	).toMatchObject({ reason: { status: 413 } });
	const first = attempts.find((result) => result.status === "fulfilled")!;
	if (first.status !== "fulfilled") throw new Error("Expected success");
	await abortUpload(owner, first.value);
	const itemId = await pending();
	state.db
		.query("UPDATE drive_items SET upload_id='old-r2-upload' WHERE id=?")
		.run(itemId);
	expect(await cleanupStaleDriveUploads()).toBe(1);
	expect((await listing()).storageUsed).toBe(0);
	const completed = await file();
	await patchDriveItem(owner, completed.id, { trashed: true });
	await expect(pending("extra")).rejects.toMatchObject({ status: 413 });
	await deleteDriveItem(owner, completed.id);
	expect((await listing()).storageUsed).toBe(0);
});
test("multipart uploads remain hidden until complete, resume and validate every byte", async () => {
	const itemId = await pending();
	expect((await listing()).items).toEqual([]);
	await put(itemId, 1, "abcd");
	const resume = await startUpload(owner, {
		name: "notes.txt",
		size: 8,
		fingerprint: "1234",
	});
	expect(resume).toMatchObject({
		id: itemId,
		uploaded: [1],
		resumed: true,
		parts: 2,
	});
	await expect(put(itemId, 2, "bad", owner, 4)).rejects.toMatchObject({
		status: 400,
	});
	await expect(finishUpload(owner, itemId)).rejects.toMatchObject({
		status: 409,
	});
	await expect(put(itemId, 3, "abcd")).rejects.toMatchObject({ status: 400 });
	await expect(put(itemId, 2, "efgh", stranger)).rejects.toMatchObject({
		status: 404,
	});
	await put(itemId, 2, "efgh");
	const result = await finishUpload(owner, itemId);
	expect(result.item?.name).toBe("notes.txt");
	expect(await new LocalStorage().file(stored(itemId).r2Key!).text()).toBe(
		"abcdefgh",
	);
	expect(
		state.db.query("SELECT count(*) AS count FROM drive_upload_parts").get(),
	).toEqual({ count: 0 });
	expect((await listing()).items).toHaveLength(1);
	await expect(finishUpload(owner, itemId)).rejects.toMatchObject({
		status: 404,
	});
});
test("corrupt or missing stored parts can be resumed without accepting bad content", async () => {
	const itemId = await pending();
	await put(itemId, 1, "abcd");
	await put(itemId, 2, "efgh");
	const part = state.db
		.query<{ etag: string }, string>(
			"SELECT etag FROM drive_upload_parts WHERE item_id=? AND part_number=1",
		)
		.get(itemId)!;
	const key = partKey(stored(itemId), 1, part.etag);
	await new LocalStorage().put(key, "wxyz");
	await expect(finishUpload(owner, itemId)).rejects.toMatchObject({
		status: 409,
	});
	const resume = await startUpload(owner, {
		name: "notes.txt",
		size: 8,
		fingerprint: "1234",
	});
	expect(resume).toMatchObject({ id: itemId, uploaded: [2] });
	await put(itemId, 1, "abcd");
	await finishUpload(owner, itemId);
	expect(await new LocalStorage().file(stored(itemId).r2Key!).text()).toBe(
		"abcdefgh",
	);
});
test("restarts release only upload leases; a lost operation cannot commit", async () => {
	const itemId = await pending();
	await driveLock(itemId, async (assertOwned) => {
		await expect(put(itemId, 1, "abcd")).rejects.toMatchObject({ status: 409 });
		await clearDriveRuntimeLeases();
		await expect(
			import("../src/server/db").then(({ withDatabase }) =>
				withDatabase((sql) => assertOwned(sql)),
			),
		).rejects.toMatchObject({ status: 409 });
	});
	await put(itemId, 1, "abcd");
	await put(itemId, 2, "efgh");
	await finishUpload(owner, itemId);
});
test("public folders expose only their subtree and revoking a link invalidates the old token", async () => {
	const parent = (await createDriveFolder(owner, { name: "Share" })).item!,
		child = await file("Inside", parent.id),
		privateFile = await file("Private");
	const token = (await linkDriveItem(owner, parent.id, true)).linkToken!;
	expect((await (await publicResponse(token)).json()).items).toHaveLength(1);
	expect(await (await publicResponse(token, child.id, true)).text()).toBe(
		"abcdefgh",
	);
	await expect(publicResponse(token, privateFile.id)).rejects.toMatchObject({
		status: 404,
	});
	await patchDriveItem(owner, parent.id, { trashed: true });
	await expect(publicResponse(token, child.id, true)).rejects.toMatchObject({
		status: 404,
	});
	await patchDriveItem(owner, parent.id, { trashed: false });
	await linkDriveItem(owner, parent.id, false);
	await expect(publicResponse(token)).rejects.toMatchObject({ status: 404 });
	expect((await linkDriveItem(owner, parent.id, true)).linkToken).not.toBe(
		token,
	);
});
test("trash ancestors hide public roots and direct shares without deleting the sharing configuration", async () => {
	const parent = (await createDriveFolder(owner, { name: "Parent" })).item!,
		child = await file("Shared file", parent.id);
	await shareDriveItem(owner, child.id, stranger.email, "edit");
	const token = (await linkDriveItem(owner, child.id, true)).linkToken!;
	await patchDriveItem(owner, parent.id, { trashed: true });
	expect(
		(await listDrive(stranger, new URLSearchParams("view=shared"))).items,
	).toEqual([]);
	await expect(publicResponse(token)).rejects.toMatchObject({ status: 404 });
	await patchDriveItem(owner, parent.id, { trashed: false });
	expect(
		(await listDrive(stranger, new URLSearchParams("view=shared"))).items,
	).toHaveLength(1);
	expect((await publicResponse(token)).status).toBe(200);
});
test("bulk moves reject cycles and trash deletion removes descendants, sharing and local files", async () => {
	const parent = (await createDriveFolder(owner, { name: "Parent" })).item!,
		nested = (
			await createDriveFolder(owner, { name: "Nested", parentId: parent.id })
		).item!,
		child = await file("Inside", nested.id);
	await shareDriveItem(owner, nested.id, stranger.email, "edit");
	await expect(
		bulkDriveItems(owner, {
			ids: [parent.id],
			action: "move",
			parentId: nested.id,
		}),
	).rejects.toMatchObject({ status: 400 });
	await expect(
		bulkDriveItems(stranger, { ids: [nested.id], action: "move" }),
	).rejects.toMatchObject({ status: 403 });
	await bulkDriveItems(owner, { ids: [parent.id], action: "trash" });
	const key = stored(child.id).r2Key!;
	await bulkDriveItems(owner, { ids: [parent.id], action: "delete" });
	expect(await new LocalStorage().file(key).exists()).toBe(false);
	expect(state.db.query("SELECT count(*) AS n FROM drive_items").get()).toEqual(
		{ n: 0 },
	);
	expect(
		state.db.query("SELECT count(*) AS n FROM drive_shares").get(),
	).toEqual({ n: 0 });
});
test("Range, If-Range, HEAD and hostile content use the original preview policy", async () => {
	const item = await file();
	const row = stored(item.id);
	const request = (headers: HeadersInit = {}, method = "GET") =>
		new Request("http://localhost/", { method, headers });
	const partial = await streamDriveFile(
		request({ Range: "bytes=2-5" }),
		row,
		false,
	);
	expect(partial.status).toBe(206);
	expect(await partial.text()).toBe("cdef");
	expect(partial.headers.get("Content-Range")).toBe("bytes 2-5/8");
	expect(
		(await streamDriveFile(request({ Range: "bytes=8-" }), row, false)).status,
	).toBe(416);
	const head = await streamDriveFile(
		request({ Range: "bytes=-2" }, "HEAD"),
		row,
		false,
	);
	expect(head.status).toBe(206);
	expect(await head.text()).toBe("");
	expect(head.headers.get("Content-Length")).toBe("2");
	expect(
		(
			await streamDriveFile(
				request({ Range: "bytes=0-1", "If-Range": '"old"' }),
				row,
				false,
			)
		).status,
	).toBe(200);
	const pdf = await streamDriveFile(
		request(),
		{ ...row, contentType: "application/pdf" },
		false,
	);
	expect(pdf.headers.get("Content-Security-Policy")).toBe(
		"frame-ancestors 'self'",
	);
	for (const contentType of ["text/html", "image/svg+xml"]) {
		const response = await streamDriveFile(
			request(),
			{ ...row, contentType },
			false,
		);
		expect(response.headers.get("Content-Type")).toBe(
			"application/octet-stream",
		);
		expect(response.headers.get("Content-Disposition")).toStartWith(
			"attachment;",
		);
	}
	expect(parseByteRange("bytes=-0", 8)).toBe("invalid");
	expect(parseByteRange("bytes=0-9007199254740992", 8)).toEqual({
		start: 0,
		end: 7,
	});
});
function attachment() {
	state.db.exec(
		"INSERT INTO message_attachments (id,message_id,filename,content_type,size,r2_key,disposition,created_at) VALUES ('attachment','message','File.pdf','application/pdf',8,'attachment-key','attachment',1)",
	);
}
test("mail attachments respect Team permissions and trash independently of their email", async () => {
	attachment();
	await new LocalStorage().put("attachment-key", "abcdefgh");
	expect((await listing("view=attachments")).items[0]).toMatchObject({
		id: "attachment",
		source: { canDelete: true, messageId: "message" },
	});
	expect(
		(await listDrive(stranger, new URLSearchParams("view=attachments"))).items,
	).toEqual([]);
	await expect(driveAttachment(stranger, "attachment")).rejects.toMatchObject({
		status: 404,
	});
	enableTeamSharing(state.db);
	state.db.exec(
		"INSERT INTO mailbox_access (id,mailbox_id,user_id,permission,created_at) VALUES ('access','mailbox','stranger','read_only',1)",
	);
	expect(
		(await listDrive(stranger, new URLSearchParams("view=attachments")))
			.items[0]?.source?.canDelete,
	).toBe(false);
	await expect(
		changeDriveAttachments(stranger, ["attachment"], "trash"),
	).rejects.toMatchObject({ status: 403 });
	state.db.exec("UPDATE mailbox_access SET permission='send_on_behalf'");
	expect(
		await changeDriveAttachments(stranger, ["attachment"], "trash"),
	).toEqual({ count: 1, denied: 0 });
	expect((await listing("view=attachments")).items).toEqual([]);
	expect((await listing("view=trash")).items[0]?.id).toBe("attachment");
	await expect(driveAttachment(owner, "attachment")).rejects.toMatchObject({
		status: 404,
	});
	expect(
		state.db.query("SELECT status FROM messages WHERE id='message'").get(),
	).toEqual({ status: "received" });
	await changeDriveAttachments(owner, ["attachment"], "restore");
	expect((await driveAttachment(owner, "attachment")).id).toBe("attachment");
	await changeDriveAttachments(owner, ["attachment"], "trash");
	await changeDriveAttachments(owner, ["attachment"], "delete");
	expect(await new LocalStorage().file("attachment-key").exists()).toBe(false);
});
test("30-day retention purges descendants and attachments but preserves shared object references", async () => {
	const parent = (await createDriveFolder(owner, { name: "Old folder" })).item!,
		child = await file("Old file", parent.id);
	attachment();
	const key = stored(child.id).r2Key!;
	state.db
		.query("UPDATE message_attachments SET r2_key=?,trashed_at=1")
		.run(key);
	state.db
		.query("UPDATE drive_items SET trashed_at=1 WHERE id=?")
		.run(parent.id);
	await runDriveRetention();
	expect((await listing()).storageUsed).toBe(0);
	expect(await new LocalStorage().file(key).exists()).toBe(false);
	const keep = await file("Keep");
	attachment();
	const keepKey = stored(keep.id).r2Key!;
	state.db
		.query("UPDATE message_attachments SET r2_key=?,trashed_at=1")
		.run(keepKey);
	await runDriveRetention();
	expect(await new LocalStorage().file(keepKey).exists()).toBe(true);
});
test("Drive rows, shares, public links and upload parts survive existing backup format", async () => {
	const parent = (await createDriveFolder(owner, { name: "Folder" })).item!;
	const itemId = await pending("Resume", parent.id);
	await put(itemId, 1, "abcd");
	await shareDriveItem(owner, parent.id, stranger.email, "edit");
	const token = (await linkDriveItem(owner, parent.id, true)).linkToken!;
	const path = join(state.directory, "backup.json");
	await writeBackup(state.path, path);
	state.db.exec("DELETE FROM drive_items");
	restoreBackup(state.db, await Bun.file(path).json());
	expect((await getDriveShares(owner, parent.id)).shares).toHaveLength(1);
	expect((await publicResponse(token)).status).toBe(200);
	expect(
		await startUpload(owner, {
			name: "Resume",
			size: 8,
			parentId: parent.id,
			fingerprint: "1234",
		}),
	).toMatchObject({ id: itemId, uploaded: [1] });
	await put(itemId, 2, "efgh");
	expect((await finishUpload(owner, itemId)).item?.name).toBe("Resume");
});

test("photo/video overlaps retain source filter behavior and suppress the documents category", async () => {
	await startUpload(owner, {
		name: "clip.mp4",
		size: 0,
		contentType: "image/png",
	});
	expect((await listing("types=photos")).items).toHaveLength(1);
	expect((await listing("types=videos")).items).toHaveLength(1);
	expect((await listing("types=documents")).items).toHaveLength(0);
});

test("an expired finalizer cannot overwrite a newer completed file", async () => {
	const itemId = await pending();
	await put(itemId, 1, "abcd");
	await put(itemId, 2, "efgh");
	const concatenate = driveFiles.concatenateParts;
	let replaced = false;
	const probe = spyOn(driveFiles, "concatenateParts").mockImplementation(
		async (...args) => {
			const result = await concatenate(...args);
			if (!replaced) {
				replaced = true;
				await clearDriveRuntimeLeases();
				await put(itemId, 1, "new!");
				await finishUpload(owner, itemId);
			}
			return result;
		},
	);
	try {
		await expect(finishUpload(owner, itemId)).rejects.toMatchObject({
			status: 409,
		});
		expect(await new LocalStorage().file(stored(itemId).r2Key!).text()).toBe(
			"new!efgh",
		);
		expect(stored(itemId).uploadId).toBeNull();
	} finally {
		probe.mockRestore();
	}
});

test("the native upload handler preserves cookie/Bearer authentication and origin checks", async () => {
	const { serveDriveUpload } = await import("../src/server/api/drive-upload");
	const { createSession } = await import("../src/server/auth/service");
	const { publicOrigin } = await import("../src/server/config");
	const token = await createSession(owner.id),
		body = JSON.stringify({ name: "empty", size: 0 });
	const request = (headers: HeadersInit) =>
		new Request("http://localhost/api/drive/upload", {
			method: "POST",
			headers,
			body,
		});
	expect(
		(
			await serveDriveUpload(
				request({
					Cookie: `ep_session=${token}`,
					Origin: "https://untrusted.example",
				}),
			)
		).status,
	).toBe(403);
	expect(
		(await serveDriveUpload(request({ Cookie: `ep_session=${token}` }))).status,
	).toBe(403);
	expect(
		(await serveDriveUpload(request({ Authorization: "Bearer invalid" })))
			.status,
	).toBe(401);
	expect(
		(
			await serveDriveUpload(
				request({ Cookie: `ep_session=${token}`, Origin: publicOrigin() }),
			)
		).status,
	).toBe(200);
	expect(
		(await serveDriveUpload(request({ Authorization: `Bearer ${token}` })))
			.status,
	).toBe(200);
});
