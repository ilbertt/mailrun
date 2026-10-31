import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/book/[userId]/[eventId]/page";
export const Route = createFileRoute("/book/$userId/$eventId")({
	component: () => <Page {...Route.useParams()} />,
});
