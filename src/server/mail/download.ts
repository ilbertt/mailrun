import { requireUser } from "../auth/request";
import { messageFile } from "./repository";
import { LocalStorage } from "../storage";
export async function downloadMessageFile(
	messageId: string,
	attachmentId?: string,
	inline = false,
) {
	const user = await requireUser();
	const metadata = await messageFile(user, messageId, attachmentId);
	const file = new LocalStorage().file(metadata.key);
	if (!(await file.exists()))
		return new Response("File not found", { status: 404 });
	return new Response(file, {
		headers: {
			"Content-Type": metadata.contentType,
			"Content-Disposition": `${inline && /^image\/(png|jpeg|gif|webp)$/.test(metadata.contentType) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(metadata.filename)}`,
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}
