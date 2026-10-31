import { Outlet, useParams } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import type { Folder } from "../shared/contracts";
import { MessageFolderPage as SourceMessageFolderPage } from "./messages/message-folder-page";
import { MessageSplitLayout } from "./messages/message-split-layout";
import { useCustomFolderConfig } from "./messages/use-custom-folder-config";
import * as folders from "./messages/message-folder-configs";
import type { MessageFolderConfig } from "./messages/types";
const configs: Record<Folder, MessageFolderConfig> = {
	inbox: folders.inboxFolderConfig,
	starred: folders.starredFolderConfig,
	snoozed: folders.snoozedFolderConfig,
	sent: folders.sentFolderConfig,
	scheduled: folders.scheduledFolderConfig,
	archived: folders.archivedFolderConfig,
	spam: folders.spamFolderConfig,
	trash: folders.trashFolderConfig,
	drafts: {
		folder: "drafts",
		title: "Drafts",
		titleKey: "navigation.drafts",
		emptyText: "No drafts",
		emptyTextKey: "folder.drafts.empty",
		hrefPrefix: "/drafts",
		icon: FileText,
		badgeVariant: "outline",
	},
};
function FolderView({ config }: { config: MessageFolderConfig }) {
	const params = useParams({ strict: false });
	if (config.folder === "drafts")
		return (
			<>
				<SourceMessageFolderPage config={config} />
				{params.messageId && <Outlet />}
			</>
		);
	return (
		<MessageSplitLayout config={config}>
			{params.messageId ? (
				<Outlet />
			) : (
				<SourceMessageFolderPage config={config} />
			)}
		</MessageSplitLayout>
	);
}
function CustomFolderView({ folderId }: { folderId: string }) {
	const config = useCustomFolderConfig(folderId);
	return <FolderView config={config} />;
}
export function MessageFolderPage({
	folder,
	folderId,
}: {
	folder: Folder;
	folderId?: string;
}) {
	return folderId ? (
		<CustomFolderView folderId={folderId} />
	) : (
		<FolderView config={configs[folder]} />
	);
}
