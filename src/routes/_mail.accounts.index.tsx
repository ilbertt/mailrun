import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(admin)/accounts/page";
export const Route = createFileRoute("/_mail/accounts/")({ component: Page });
