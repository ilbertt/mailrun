import { createFileRoute } from "@tanstack/react-router";
import { threadQuery } from "../queries";
import { Conversation } from "../components/conversation";
export const Route = createFileRoute("/_mail/inbox/$messageId")({
	loader: ({ context, params }) =>
		context.queryClient.ensureQueryData(
			threadQuery(context.user.id, params.messageId),
		),
	component: () => <Conversation messageId={Route.useParams().messageId} />,
});
