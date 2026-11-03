import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(settings)/settings/rules/page";
export const Route = createFileRoute("/_mail/settings/rules")({
	component: Page,
});
