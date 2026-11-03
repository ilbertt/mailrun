import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(settings)/settings/inbox/page";
export const Route = createFileRoute("/_mail/settings/inbox")({
	component: Page,
});
