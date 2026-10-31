import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(admin)/mailboxes/page";
export const Route = createFileRoute("/_mail/mailboxes/")({ component: Page });
