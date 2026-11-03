import type { Folder } from "./contracts";
export type FolderCount = { total: number; unread: number };
export function emptyNavigationCounts() {
	const folders: Record<Folder, FolderCount> = {
		inbox: { total: 0, unread: 0 },
		starred: { total: 0, unread: 0 },
		snoozed: { total: 0, unread: 0 },
		sent: { total: 0, unread: 0 },
		scheduled: { total: 0, unread: 0 },
		drafts: { total: 0, unread: 0 },
		archived: { total: 0, unread: 0 },
		spam: { total: 0, unread: 0 },
		trash: { total: 0, unread: 0 },
	};
	return { folders, customFolders: {} as Record<string, FolderCount> };
}
