import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/_mail/settings/")({
	beforeLoad: () => {
		throw redirect({ to: "/settings/account", replace: true });
	},
});
