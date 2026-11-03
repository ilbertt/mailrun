import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/book/[userId]/page";
export const Route = createFileRoute("/book/$userId/")({
	component: () => <Page {...Route.useParams()} />,
});
