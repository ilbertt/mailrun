import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(admin)/backups/page";
export const Route = createFileRoute("/_mail/backups")({ component: Page });
