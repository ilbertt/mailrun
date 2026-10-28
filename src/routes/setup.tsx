import { createFileRoute, redirect } from "@tanstack/react-router";
import { sessionQuery } from "../queries";
import { RegisterClient } from "../app/(auth)/register/register-client";
import { OnboardingClient } from "../app/(auth)/onboarding/onboarding-client";
export const Route = createFileRoute("/setup")({
	loader: async ({ context }) => {
		const session = await context.queryClient.ensureQueryData(sessionQuery());
		if (!session.needsSetup && !session.user) throw redirect({ to: "/login" });
		if (session.user && !session.needsSetup) {
			if (session.user.role !== "admin" || !session.needsOnboarding)
				throw redirect({ to: "/inbox" });
		}
		return { user: session.needsSetup ? null : session.user };
	},
	component: () =>
		Route.useLoaderData().user ? <OnboardingClient /> : <RegisterClient />,
});
