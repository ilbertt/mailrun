import { createFileRoute, redirect } from "@tanstack/react-router";
import { sessionQuery } from "../queries";
import { ForgotPasswordClient } from "../app/(auth)/forgot-password/forgot-password-client";
export const Route = createFileRoute("/forgot-password")({
	beforeLoad: async ({ context }) => {
		const session = await context.queryClient.ensureQueryData(sessionQuery());
		if (session.user) throw redirect({ to: "/inbox" });
	},
	component: ForgotPasswordClient,
});
