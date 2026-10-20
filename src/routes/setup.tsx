import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { registerFn, setupCloudflareFn, setupStatusFn } from "../functions";
import { sessionQuery } from "../queries";

export const Route = createFileRoute("/setup")({
	loader: async ({ context }) => {
		const session = await context.queryClient.ensureQueryData(sessionQuery());
		if (!session.needsSetup && !session.user) throw redirect({ to: "/login" });
		if (session.user && !session.user.isPrimaryAdmin) throw redirect({ to: "/inbox" });
		return { ...session, installation: session.user ? await setupStatusFn() : null };
	},
	component: Setup,
});
function Setup() {
	const { user, installation } = Route.useLoaderData();
	const { queryClient } = Route.useRouteContext();
	const router = useRouter();
	const claim = useMutation({ mutationFn: registerFn, onSuccess: async () => { queryClient.clear(); await router.invalidate(); } });
	const connect = useMutation({ mutationFn: setupCloudflareFn, onSuccess: async () => { await router.invalidate(); } });
	return <main className="auth wide"><div className="brand">✉ Mailrun</div><h1>{user ? "Connect your email" : "Set up Mailrun"}</h1>
		<p className="notice">Migration preview: connect a test domain. Advanced routing and the remaining Mailflare features are still being migrated.</p>
		{!user ? <form onSubmit={event => {
			event.preventDefault(); const form = new FormData(event.currentTarget);
			claim.mutate({ data: { name: String(form.get("name")), email: String(form.get("email")), password: String(form.get("password")), setupToken: String(form.get("setupToken")) } });
		}}>
			<p>Create the owner account using your installation's setup token.</p>
			<label>Name<input name="name" autoComplete="name" required /></label>
			<label>Email<input name="email" type="email" autoComplete="username" required /></label>
			<label>Password<input name="password" type="password" autoComplete="new-password" minLength={12} required /></label>
			<label>Setup token<input name="setupToken" type="password" autoComplete="off" required /></label>
			{claim.error && <p className="error" role="alert">{claim.error.message}</p>}
			<button className="primary" disabled={claim.isPending}>{claim.isPending ? "Creating account…" : "Create account"}</button>
		</form> : <form onSubmit={event => {
			event.preventDefault(); const form = new FormData(event.currentTarget);
			connect.mutate({ data: { accountId: String(form.get("accountId")), hostname: String(form.get("hostname")), apiToken: String(form.get("apiToken")), localPart: String(form.get("localPart")), activateRouting: form.get("activateRouting") === "on" } });
		}}>
			<p>Mailrun will deploy your email relay and connect your domain through Cloudflare.</p>
			{installation && <p className="notice">{installation.hostname}: {installation.phase}</p>}
			<label>Cloudflare account ID<input name="accountId" required /></label>
			<label>Domain<input name="hostname" placeholder="example.com" defaultValue={installation?.hostname} required /></label>
			<label>Cloudflare API token<input name="apiToken" type="password" autoComplete="off" required /></label>
			<p className="hint">Allow Worker deployment, Zone Read, DNS Edit, Email Routing and Email Sending for this account and domain.</p>
			<label>First mailbox<input name="localPart" placeholder="hello" required /></label>
			<label className="check"><input name="activateRouting" type="checkbox" /> Route this domain's incoming email to Mailrun after verifying the relay. This replaces its catch-all rule.</label>
			{connect.error && <p className="error" role="alert">{connect.error.message}</p>}
			{connect.isSuccess && <p className="notice">Relay configured. {connect.data?.phase === "ready" ? "Email routing is active." : "Connect again with routing enabled when you're ready."}</p>}
			<button className="primary" disabled={connect.isPending}>{connect.isPending ? "Connecting Cloudflare…" : "Connect email"}</button>
			<Link to="/inbox">Open inbox</Link>
		</form>}
		<a className="source" href="https://github.com/ilbertt/mailrun">Source code</a>
	</main>;
}
