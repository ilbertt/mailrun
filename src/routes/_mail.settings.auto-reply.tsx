import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/_mail/settings/auto-reply")({
	beforeLoad: () => {
		throw redirect({ to: "/settings/inbox", replace: true });
	},
});
