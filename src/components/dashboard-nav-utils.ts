import type { Folder } from "../shared/contracts";
import type { FolderCount } from "../shared/navigation";
import { bulkMessageActionFn } from "../functions";
export function getFolderNavCount(
	folder: Folder,
	counts: Record<Folder, FolderCount>,
) {
	return folder === "drafts" ? counts[folder].total : counts[folder].unread;
}
export function moveMessagesToSystemFolder(
	messageIds: string[],
	action: "archive" | "spam" | "trash",
) {
	return bulkMessageActionFn({ data: { messageIds, action } });
}
export function moveMessagesToCustomFolder(
	messageIds: string[],
	folderId: string,
) {
	return bulkMessageActionFn({
		data: { messageIds, action: "folder", folderId },
	});
}
