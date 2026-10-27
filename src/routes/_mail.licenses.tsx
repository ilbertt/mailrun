import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(admin)/licenses/page";
export const Route = createFileRoute("/_mail/licenses")({ component: Page });
