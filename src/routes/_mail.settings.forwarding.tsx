import { createFileRoute } from "@tanstack/react-router";
import { ForwardingSettings } from "../components/mail-settings";
export const Route = createFileRoute("/_mail/settings/forwarding")({
	component: ForwardingSettings,
});
