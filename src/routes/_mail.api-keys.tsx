import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(admin)/api-keys/page";
export const Route = createFileRoute("/_mail/api-keys")({ component: Page });
