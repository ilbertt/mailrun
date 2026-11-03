import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(admin)/agent/page";
export const Route = createFileRoute("/_mail/agent")({ component: Page });
