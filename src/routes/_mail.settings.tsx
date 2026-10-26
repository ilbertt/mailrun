import { createFileRoute, Outlet } from "@tanstack/react-router";
import SettingsLayout from "../app/(settings)/settings/layout";
export const Route = createFileRoute("/_mail/settings")({
	component: () => (
		<SettingsLayout>
			<Outlet />
		</SettingsLayout>
	),
});
