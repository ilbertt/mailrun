import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/d/[token]/page";
export const Route = createFileRoute("/d/$token")({ component: PublicDrive });
function PublicDrive() {
	const { token } = Route.useParams();
	return <Page token={token} />;
}
