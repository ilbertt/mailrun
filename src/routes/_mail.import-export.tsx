import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/_mail/import-export")({
	beforeLoad: () => {
		throw redirect({ to: "/settings/import", replace: true });
	},
});
