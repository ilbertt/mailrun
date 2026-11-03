import type { MessageCounts, MessageFolder } from "@/hooks/types";
export type MessageCountRow = {
	mailboxId: string | null;
	folderId: string | null;
	direction: string;
	status: string;
	read: boolean;
	starred: boolean;
	snoozedUntil: Date | null;
	total?: number;
};
export type FolderAccumulator = MessageCounts["folders"];
export type CountableFolder = MessageFolder | null;
