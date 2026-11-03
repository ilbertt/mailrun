import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(settings)/settings/api-keys/page";
export const Route = createFileRoute("/_mail/settings/api-keys")({
	component: Page,
});
