import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(admin)/domains/page";
export const Route = createFileRoute("/_mail/domains")({ component: Page });
