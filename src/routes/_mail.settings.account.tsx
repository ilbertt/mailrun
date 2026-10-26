import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(settings)/settings/account/page";
export const Route = createFileRoute("/_mail/settings/account")({
	component: Page,
});
