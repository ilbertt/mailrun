import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(admin)/accounts/[id]/password/page";
export const Route = createFileRoute("/_mail/accounts/$id/password")({
	component: AccountPage,
});
function AccountPage() {
	return <Page accountId={Route.useParams().id} />;
}
