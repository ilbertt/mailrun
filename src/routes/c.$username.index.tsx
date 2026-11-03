import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/book/[userId]/page";
export const Route = createFileRoute("/c/$username/")({
	component: () => <Page {...Route.useParams()} />,
});
