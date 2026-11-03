import { createFileRoute } from "@tanstack/react-router";
import { MessageFolderPage } from "../components/message-folder-page";
export const Route = createFileRoute("/_mail/drafts")({
	component: () => <MessageFolderPage folder="drafts" />,
});
