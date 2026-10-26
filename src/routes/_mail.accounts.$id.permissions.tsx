import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(admin)/accounts/[id]/permissions/page";
export const Route = createFileRoute("/_mail/accounts/$id/permissions")({
	component: AccountPage,
});
function AccountPage() {
	return <Page accountId={Route.useParams().id} />;
}
