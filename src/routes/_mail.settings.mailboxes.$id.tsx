import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(settings)/settings/mailboxes/[id]/page";
export const Route = createFileRoute("/_mail/settings/mailboxes/$id")({
	component: () => <Page mailboxId={Route.useParams().id} />,
});
