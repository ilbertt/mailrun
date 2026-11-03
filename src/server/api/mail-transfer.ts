import type { User } from "../../shared/contracts";
import { parseImportUpload, importMessages } from "../mail-transfer/import";
import { exportMailbox } from "../mail-transfer/export";
import {
	imapLoginSchema,
	parseImapImport,
	listImapFolders,
	fetchImapBatch,
} from "../mail-transfer/imap";
import { validateImport } from "../mail-transfer/repository";
import { readLimitedBody } from "../mail/inbound";
import { serveSessionApi } from "./session";
export const isMailTransferPath = (path: string) =>
	/^\/api\/(?:import\/(?:messages|imap(?:\/folders)?)|export\/messages)$/.test(
		path,
	);
export const serveMailTransfer = (
	request: Request,
	onAuthorized?: () => void,
) =>
	serveSessionApi(request, (current, user) => {
		onAuthorized?.();
		return mailTransferApi(current, user);
	});
export async function mailTransferApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	const url = new URL(request.url),
		path = url.pathname;
	if (path === "/api/import/messages" && request.method === "POST") {
		let upload: Awaited<ReturnType<typeof parseImportUpload>>;
		try {
			upload = await parseImportUpload(request);
		} catch (error) {
			if (
				error instanceof Response ||
				(error instanceof Error && error.message === "Message too large")
			)
				throw error;
			throw new Response("Invalid import upload", { status: 400 });
		}
		return Response.json(
			await importMessages(
				user,
				upload.mailboxId,
				upload.destination,
				upload.messages,
				request.signal,
			),
		);
	}
	if (
		path === "/api/export/messages" &&
		["GET", "HEAD"].includes(request.method)
	) {
		const mailboxId = url.searchParams.get("mailboxId");
		if (!mailboxId) throw new Response("Mailbox is required", { status: 400 });
		return exportMailbox(user, mailboxId, request.method === "HEAD");
	}
	if (
		(path === "/api/import/imap" || path === "/api/import/imap/folders") &&
		request.method === "POST"
	) {
		const body: unknown = JSON.parse(
			new TextDecoder().decode(await readLimitedBody(request, 16 * 1024)),
		);
		if (path.endsWith("/folders")) {
			const input = imapLoginSchema.parse(body);
			try {
				return Response.json({
					folders: await listImapFolders(input, undefined, request.signal),
				});
			} catch (error) {
				throw new Response(
					error instanceof Error
						? error.message
						: "Unable to list IMAP folders",
					{ status: 502 },
				);
			}
		}
		const input = parseImapImport(body);
		await validateImport(user, input.mailboxId, input.destination);
		let batch: Awaited<ReturnType<typeof fetchImapBatch>> | undefined;
		try {
			batch = await fetchImapBatch(input, undefined, request.signal);
			const result = await importMessages(
				user,
				input.mailboxId,
				input.destination,
				batch.messages(),
				request.signal,
			);
			return Response.json({
				...result,
				total: batch.total,
				nextOffset: batch.nextOffset,
			});
		} catch (error) {
			if (error instanceof Response) throw error;
			throw new Response(
				error instanceof Error ? error.message : "IMAP import failed",
				{ status: 502 },
			);
		} finally {
			await batch?.cleanup();
		}
	}
	return null;
}
