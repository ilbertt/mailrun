import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useCompose } from "../components/compose/compose-context";
export const Route = createFileRoute("/_mail/drafts/$messageId")({
	component: OpenDraft,
});
function OpenDraft() {
	const { messageId } = Route.useParams();
	const { openDraftComposer } = useCompose();
	const opened = useRef<string | null>(null);
	useEffect(() => {
		if (opened.current === messageId) return;
		opened.current = messageId;
		openDraftComposer(messageId);
	}, [messageId, openDraftComposer]);
	return null;
}
