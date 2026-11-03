import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(admin)/accounts/[id]/page";
export const Route = createFileRoute("/_mail/accounts/$id/")({
	component: AccountPage,
});
function AccountPage() {
	return <Page accountId={Route.useParams().id} />;
}
