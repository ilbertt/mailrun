import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(dashboard)/compose/page";
export const Route = createFileRoute("/_mail/compose")({
	component: Page,
});
