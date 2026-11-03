import { z } from "zod";
import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(calendar)/calendar/page";
export const Route = createFileRoute("/_mail/calendar")({
	validateSearch: z.object({ event: z.string().optional() }),
	component: Page,
});
