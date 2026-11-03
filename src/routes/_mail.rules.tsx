import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/_mail/rules")({
	beforeLoad: () => {
		throw redirect({ to: "/settings/account", replace: true });
	},
});
