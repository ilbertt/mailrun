import { createTranslator } from "../lib/i18n/utils";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { sessionQuery } from "../queries";
import { LoginClient } from "../app/(auth)/login/login-client";
export const Route = createFileRoute("/login")({
	validateSearch: z.object({ add: z.string().optional() }),
	beforeLoad: async ({ context, search }) => {
		const session = await context.queryClient.fetchQuery(sessionQuery());
		if (session.needsSetup) throw redirect({ to: "/setup" });
		if (session.user && search.add !== "1") throw redirect({ to: "/inbox" });
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
