import { createTranslator } from "../lib/i18n/utils";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { loadRouteSession } from "../queries";
import { ForgotPasswordClient } from "../app/(auth)/forgot-password/forgot-password-client";
export const Route = createFileRoute("/forgot-password")({
	beforeLoad: async ({ context, location, preload }) => {
		const session = await loadRouteSession(
			context.queryClient,
			location.pathname,
			preload,
		);
		if (!preload && !session.fromServer && session.verified && session.user)
			throw redirect({ to: "/inbox" });
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
