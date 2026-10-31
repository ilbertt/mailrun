import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(dashboard)/agent/review/[id]/page";
export const Route = createFileRoute("/_mail/agent_/review/$id")({
	component: ReviewPage,
});

function ReviewPage() {
	const { id } = Route.useParams();
	return <Page key={id} id={id} />;
}
