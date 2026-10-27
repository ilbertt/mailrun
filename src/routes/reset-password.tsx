import { z } from "zod";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { sessionQuery } from "../queries";
import { ResetPasswordClient } from "../app/(auth)/reset-password/reset-password-client";
export const Route = createFileRoute("/reset-password")({
	validateSearch: z.object({ token: z.string().optional() }),
	beforeLoad: async ({ context }) => {
		const session = await context.queryClient.ensureQueryData(sessionQuery());
		if (session.user) throw redirect({ to: "/inbox" });
	},
	component: ResetPasswordClient,
});
