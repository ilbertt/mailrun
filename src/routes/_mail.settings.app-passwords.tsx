import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(settings)/settings/app-passwords/page";
export const Route = createFileRoute("/_mail/settings/app-passwords")({
	component: Page,
});
