import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(settings)/settings/export/page";
export const Route = createFileRoute("/_mail/settings/export")({
	component: Page,
});
