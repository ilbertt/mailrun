import { createFileRoute } from "@tanstack/react-router";
import { ComposeForm } from "../components/compose/compose-form";
export const Route = createFileRoute("/_mail/compose")({
	component: () => <ComposeForm />,
});
