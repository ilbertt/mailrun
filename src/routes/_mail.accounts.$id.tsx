import { createFileRoute, Outlet } from "@tanstack/react-router";
import Layout from "../app/(admin)/accounts/[id]/layout";
export const Route = createFileRoute("/_mail/accounts/$id")({
	component: AccountLayout,
});
function AccountLayout() {
	return (
		<Layout accountId={Route.useParams().id}>
			<Outlet />
		</Layout>
	);
}
