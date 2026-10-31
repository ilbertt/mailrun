import { createTranslator } from "../lib/i18n/utils";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { loadRouteSession } from "../queries";
import { LoginClient } from "../app/(auth)/login/login-client";
export const Route = createFileRoute("/login")({
	validateSearch: z.object({ add: z.string().optional() }),
	beforeLoad: async ({ context, search, location, preload }) => {
		const session = await loadRouteSession(
			context.queryClient,
			location.pathname,
			preload,
		);
		if (!preload && session.needsSetup) throw redirect({ to: "/setup" });
		if (
			!session.fromServer &&
			session.verified &&
			session.user &&
			search.add !== "1"
		)
			throw redirect({ to: "/inbox" });
	},
	head: ({ match }) => ({
		meta: [
			{
				title: `${createTranslator(match.context.document.locale, match.context.document.messages)("auth.signIn")} - ${match.context.document.branding.appName}`,
			},
		],
	}),
	component: () => <LoginClient adding={Route.useSearch().add === "1"} />,
});
