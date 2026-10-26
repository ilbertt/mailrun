import { createFileRoute } from "@tanstack/react-router";
import { MessageFolderPage } from "../components/message-folder-page";
export const Route = createFileRoute("/_mail/folders/$folderId")({
	component: () => (
		<MessageFolderPage folder="inbox" folderId={Route.useParams().folderId} />
	),
});
