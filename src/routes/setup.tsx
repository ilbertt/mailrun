import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { LoadingTransition } from "../components/loading-transition";
import { loadRouteSession } from "../queries";
import { RegisterClient } from "../app/(auth)/register/register-client";
import { OnboardingClient } from "../app/(auth)/onboarding/onboarding-client";
export const Route = createFileRoute("/setup")({
	loader: async ({ context, location }) => {
		const session = await loadRouteSession(
			context.queryClient,
			location.pathname,
		);
		if (!session.needsSetup && !session.user) throw redirect({ to: "/login" });
		if (session.user && !session.needsSetup) {
			if (session.user.role !== "admin" || !session.needsOnboarding)
				throw redirect({ to: "/inbox" });
		}
		return { user: session.needsSetup ? null : session.user, fromServer: session.fromServer };
	},
	component: SetupPage,
});
function SetupPage() {
	const { user, fromServer } = Route.useLoaderData();
	const router = useRouter();
	useEffect(() => { if (fromServer) void router.invalidate(); }, [fromServer, router]);
	return user ? <LoadingTransition ready={!fromServer}><OnboardingClient /></LoadingTransition> : <RegisterClient />;
}
