import type { User } from "../../shared/contracts";
import {
	backupInventory,
	saveBackupSettings,
	runManualBackup,
	removeBackup,
	downloadBackup,
	restoreRecords,
} from "../backups/service";
import { readLimitedBody } from "../mail/inbound";
import { withDatabase } from "../db";
import { keyActor } from "../auth/key-management";
export async function backupsApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	const path = new URL(request.url).pathname,
		method = request.method;
	if (path === "/api/backups") {
		if (method === "GET")
			return Response.json(await backupInventory(user), {
				headers: { "Cache-Control": "no-store" },
			});
		if (method === "PUT") {
			await saveBackupSettings(
				user,
				JSON.parse(
					new TextDecoder().decode(await readLimitedBody(request, 16 * 1024)),
				),
			);
			return Response.json({ ok: true });
		}
		if (method === "POST")
			return Response.json({ backupId: await runManualBackup(user) });
	}
	if (path === "/api/backups/restore" && method === "POST") {
		await withDatabase((sql) => keyActor(sql, user, true));
		const form = await request.formData(),
			file = form.get("backup");
		if (!(file instanceof File))
			throw new Response("Choose a backup file", { status: 400 });
		if (file.size > 30 * 1024 * 1024)
			throw new Response("Request body too large", { status: 413 });
		let document: unknown;
		try {
			document = JSON.parse(await file.text());
		} catch {
			throw new Response("Invalid backup JSON", { status: 400 });
		}
		try {
			await restoreRecords(user, document);
		} catch (error) {
			if (error instanceof Response) throw error;
			throw new Response(
				error instanceof Error ? error.message : "Failed to restore backup",
				{ status: 400 },
			);
		}
		return Response.json({ ok: true });
	}
	const match = /^\/api\/backups\/([^/]+)(\/download)?$/.exec(path);
	if (match) {
		const backupId = decodeURIComponent(match[1]!);
		if (match[2] && (method === "GET" || method === "HEAD"))
			return downloadBackup(user, backupId, method === "HEAD");
		if (!match[2] && method === "DELETE") {
			await removeBackup(user, backupId);
			return Response.json({ ok: true });
		}
	}
	return null;
}
