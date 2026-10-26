import { requireUser } from "../auth/request";
import { messageFile } from "./repository";
import { LocalStorage } from "../storage";
import {
	getInlineContentType,
	getMimeEssence,
} from "../../lib/http/content-type";
export async function downloadMessageFile(
	messageId: string,
	attachmentId?: string,
	options: boolean | { preview?: boolean; download?: boolean } = false,
) {
	const user = await requireUser(),
		metadata = await messageFile(user, messageId, attachmentId);
	const file = new LocalStorage().file(metadata.key);
	if (!(await file.exists()))
		return new Response("File not found", { status: 404 });
	const preview = typeof options === "boolean" ? options : options.preview,
		download = typeof options === "boolean" ? false : options.download;
	const inlineType = download
		? null
		: getInlineContentType(metadata.contentType);
	const inline =
		!!attachmentId &&
		inlineType !== null &&
		(preview ||
			("disposition" in metadata && metadata.disposition === "inline"));
	return new Response(file, {
		headers: {
			"Content-Type":
				inline && inlineType
					? inlineType
					: (getMimeEssence(metadata.contentType) ??
						"application/octet-stream"),
			"Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(metadata.filename)}`,
			"Content-Length": String(file.size),
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
			"X-Frame-Options": "SAMEORIGIN",
			"Content-Security-Policy":
				"default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox",
		},
	});
}
