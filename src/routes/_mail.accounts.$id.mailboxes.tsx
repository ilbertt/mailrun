import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(admin)/accounts/[id]/mailboxes/page";
export const Route = createFileRoute("/_mail/accounts/$id/mailboxes")({
	component: AccountPage,
});
function AccountPage() {
	return <Page accountId={Route.useParams().id} />;
}
