import { createFileRoute } from "@tanstack/react-router";
import { RoutingSettings } from "../components/mail-settings";
export const Route = createFileRoute("/_mail/settings/rules")({
	component: RoutingSettings,
});
