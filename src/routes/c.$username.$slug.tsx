import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/book/[userId]/[eventId]/page";
export const Route = createFileRoute("/c/$username/$slug")({
	component: () => <Page {...Route.useParams()} />,
});
