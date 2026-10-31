import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(admin)/admin/page";
export const Route = createFileRoute("/_mail/admin")({ component: Page });
