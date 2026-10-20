import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { loginFn } from "../functions";
import { sessionQuery } from "../queries";

export const Route = createFileRoute("/login")({
	beforeLoad: async ({ context }) => {
		const session = await context.queryClient.ensureQueryData(sessionQuery());
		if (session.needsSetup) throw redirect({ to: "/setup" });
		if (session.user) throw redirect({ to: "/inbox" });
	},
	component: Login,
});
function Login() {
	const router = useRouter();
	const { queryClient } = Route.useRouteContext();
	const [mfa, setMfa] = useState(false);
	const mutation = useMutation({
		mutationFn: loginFn,
		onSuccess: async result => {
			if (result.mfaRequired) { setMfa(true); return; }
			queryClient.clear();
			await router.navigate({ to: "/inbox" });
		},
	});
	return <main className="auth"><div className="brand">✉ Mailrun</div><h1>Welcome back</h1><p>Your mail, at your pace.</p>
		<form onSubmit={event => {
			event.preventDefault();
			const form = new FormData(event.currentTarget);
			mutation.mutate({ data: { email: String(form.get("email")), password: String(form.get("password")), ...(mfa ? { code: String(form.get("code")) } : {}) } });
		}}>
			<label>Email<input name="email" type="email" autoComplete="username" required /></label>
			<label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
			{mfa && <label>Authentication or recovery code<input name="code" autoComplete="one-time-code" required autoFocus /></label>}
			{mutation.error && <p role="alert" className="error">{mutation.error.message}</p>}
			<button className="primary" disabled={mutation.isPending}>{mutation.isPending ? "Signing in…" : "Sign in"}</button>
		</form><a className="source" href="https://github.com/ilbertt/mailrun">Source code</a>
	</main>;
}
