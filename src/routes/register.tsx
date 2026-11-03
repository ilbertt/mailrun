import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/register")({
	beforeLoad: () => {
		throw redirect({ to: "/setup", statusCode: 307 });
	},
});
