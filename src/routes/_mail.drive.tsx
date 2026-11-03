import { z } from "zod";
import { createFileRoute } from "@tanstack/react-router";
import Page from "../app/(drive)/drive/page";
export const Route = createFileRoute("/_mail/drive")({
	validateSearch: z.object({
		view: z.enum(["my", "shared", "attachments", "trash"]).optional(),
		folder: z.string().optional(),
		q: z.string().optional(),
		types: z.string().optional(),
	}),
	component: Page,
});
