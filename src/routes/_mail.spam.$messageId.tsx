import { createFileRoute } from "@tanstack/react-router";
import { Conversation } from "../components/conversation";
export const Route = createFileRoute("/_mail/spam/$messageId")({
	component: () => <Conversation messageId={Route.useParams().messageId} />,
});
