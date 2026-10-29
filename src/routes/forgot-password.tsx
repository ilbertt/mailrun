import { createTranslator } from "../lib/i18n/utils";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { sessionQuery } from "../queries";
import { ForgotPasswordClient } from "../app/(auth)/forgot-password/forgot-password-client";
export const Route = createFileRoute("/forgot-password")({
	beforeLoad: async ({ context }) => {
		const session = await context.queryClient.ensureQueryData(sessionQuery());
		if (session.user) throw redirect({ to: "/inbox" });
	},
	head: ({ match }) => ({
		meta: [
			{
				title: `${createTranslator(match.context.document.locale, match.context.document.messages)("auth.forgot.title")} - ${match.context.document.branding.appName}`,
			},
		],
	}),
	component: ForgotPasswordClient,
});
