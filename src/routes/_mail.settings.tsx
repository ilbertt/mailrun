import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { mailSettingsQuery } from "../queries";
import { RelayUpdate } from "../components/mail-settings";
export const Route = createFileRoute("/_mail/settings")({
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(mailSettingsQuery(context.user.id)),
	component: () => (
		<div className="flex h-full min-h-0 max-md:flex-col">
			<aside className="w-52 shrink-0 space-y-1 border-r border-neutral-100 px-4 py-7 max-md:flex max-md:w-full max-md:gap-1 max-md:overflow-x-auto max-md:px-2 max-md:py-2">
				<h1 className="mb-6 px-3 text-xl max-md:hidden">Settings</h1>
				{[
					{ to: "/settings/mailboxes", label: "Mailboxes & aliases" },
					{ to: "/settings/rules", label: "Routing rules" },
					{ to: "/settings/forwarding", label: "Forwarding" },
				].map((item) => (
					<Link
						key={item.to}
						to={item.to}
						activeProps={{ className: "bg-blue-50 text-blue-700" }}
						className="block rounded-lg px-3 py-2 text-sm"
					>
						{item.label}
					</Link>
				))}
				<Link to="/setup" className="block rounded-lg px-3 py-2 text-sm">
					Email setup
				</Link>
			</aside>
			<section className="min-h-0 min-w-0 flex-1 overflow-y-auto px-8 py-7 max-md:px-4 max-md:py-4">
				<RelayUpdate />
				<Outlet />
			</section>
		</div>
	),
});
