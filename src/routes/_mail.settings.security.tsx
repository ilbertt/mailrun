import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(settings)/settings/security/page";
export const Route = createFileRoute("/_mail/settings/security")({
	component: Page,
});
