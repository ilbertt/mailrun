import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/_mail/audit-logs")({
	beforeLoad: () => {
		throw redirect({ to: "/activity", replace: true });
	},
});
