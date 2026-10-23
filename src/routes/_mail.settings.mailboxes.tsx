import { createFileRoute } from "@tanstack/react-router";
import { MailboxSettings } from "../components/mail-settings";
export const Route = createFileRoute("/_mail/settings/mailboxes")({
	component: MailboxSettings,
});
