import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(admin)/mailboxes/[id]/page";
export const Route = createFileRoute("/_mail/mailboxes/$id")({
	component: () => <Page mailboxId={Route.useParams().id} />,
});
