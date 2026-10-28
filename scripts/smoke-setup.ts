import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";
import { fixture } from "../tests/fixtures";
import {
	startFixtureSetupProvider,
	writeSetupFixturePreload,
} from "../tests/setup-provider";
const state = await fixture(),
	provider = await startFixtureSetupProvider(state.directory),
	preload = await writeSetupFixturePreload(state.directory, provider.url),
	binary = resolve(process.argv[2] ?? "dist/mailrun-local"),
	setupToken = crypto.randomUUID();
state.db.exec("DELETE FROM users");
const env = {
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	TMPDIR: process.env.TMPDIR,
	DATA_DIR: state.directory,
	HOST: "127.0.0.1",
	PORT: "0",
	APP_URL: provider.publicOrigin,
	SETUP_TOKEN: setupToken,
	CF_TOKEN: "test-cloudflare-token",
	CF_ACCOUNT_ID: "a".repeat(32),
	NODE_EXTRA_CA_CERTS: provider.cert,
	BUN_OPTIONS: "--preload " + preload.path,
};
let child: ReturnType<typeof Bun.spawn> | undefined,
	base = "";
const errors: Promise<string>[] = [];
async function start() {
	child = Bun.spawn([binary], {
		cwd: state.directory,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (
		!child.stdout ||
		typeof child.stdout === "number" ||
		typeof child.stderr === "number"
	)
		throw new Error("Missing fixture output pipes");
	errors.push(new Response(child.stderr).text());
	const reader = child.stdout.getReader();
	let output = "",
		timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			(async () => {
				for (;;) {
					const next = await reader.read();
					if (next.done)
						throw new Error("Setup server exited before listening");
					output += new TextDecoder().decode(next.value);
					const found = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
					if (found) {
						base = found;
						break;
					}
				}
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Setup server did not boot")),
					10_000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
	provider.setAppBase(base);
	if (!existsSync(preload.marker))
		throw new Error("Setup provider preload was not loaded");
}
async function stop() {
	if (child) {
		child.kill("SIGTERM");
		await child.exited;
		child = undefined;
	}
}
async function post(path: string, body: unknown, token: string = setupToken) {
	return fetch(base + path, {
		method: "POST",
		headers: {
			Origin: provider.publicOrigin,
			"Content-Type": "application/json",
			"X-Mailrun-Setup-Token": token,
		},
		body: JSON.stringify(body),
	});
}
try {
	await start();
	for (const path of ["/register", "/onboarding"]) {
		const response = await fetch(base + path, { redirect: "manual" });
		if (
			response.status !== 307 ||
			response.headers.get("Location") !== "/setup"
		)
			throw new Error("Original setup alias differs: " + path);
		await response.body?.cancel();
	}
	const page = await fetch(base + "/setup"),
		html = await page.text();
	if (
		!page.ok ||
		html.includes("Migration preview") ||
		!html.includes("System")
	)
		throw new Error("Original setup screen did not render");
	const status = z
		.object({ hasAdminAccount: z.boolean(), hasPrimaryDomain: z.boolean() })
		.parse(await (await fetch(base + "/api/setup/status")).json());
	if (status.hasAdminAccount || status.hasPrimaryDomain)
		throw new Error("Setup was not isolated");
	const prepared = await post("/api/setup/prepare", {});
	if (!prepared.ok) throw new Error("Local setup requirements failed");
	await prepared.body?.cancel();
	const refused = await post(
		"/api/setup/domain",
		{ hostname: "example.com" },
		"wrong-token",
	);
	if (refused.status !== 403)
		throw new Error("Domain preflight accepted a wrong setup token");
	await refused.body?.cancel();
	const domain = await post("/api/setup/domain", { hostname: "example.com" });
	if (!domain.ok) throw new Error("Domain preflight failed");
	await domain.body?.cancel();
	provider.cf.addRecord({
		type: "MX",
		name: "example.com",
		content: "old.mail.example",
		priority: 5,
	});
	const mx = await post("/api/setup/domain/mx", { hostname: "example.com" });
	if (
		!z.object({ hasExistingMx: z.literal(true) }).safeParse(await mx.json())
			.success
	)
		throw new Error("MX consent was omitted");
	const input = {
		domain: "example.com",
		username: "me",
		password: "eight123",
		resetEmail: "recovery@example.org",
		setupToken,
		enableSending: false,
		replaceMxRecords: true,
	};
	provider.setHealthy(false);
	const failed = await post("/api/auth/register", input);
	if (failed.status !== 502)
		throw new Error(
			"Unhealthy relay did not return a recoverable provider failure",
		);
	await failed.body?.cancel();
	if (
		state.db.query("SELECT id FROM users").all().length ||
		state.db.query("SELECT id FROM domains").all().length
	)
		throw new Error("Failed setup left a partial account");
	const previousWorker = provider.workerName;
	provider.setHealthy(true);
	const created = await post("/api/auth/register", input);
	if (!created.ok)
		throw new Error("First-account setup failed: " + (await created.text()));
	if (
		!z
			.object({ ok: z.literal(true), redirect: z.literal("/login") })
			.safeParse(await created.json()).success ||
		!created.headers.get("Set-Cookie")?.includes("Max-Age=0")
	)
		throw new Error("Setup did not finish at the original login boundary");
	if (provider.workerName !== previousWorker || provider.cf.identities.length)
		throw new Error("Retry changed the Worker or ignored receive-only mode");
	await stop();
	await start();
	const closed = await post("/api/auth/register", input);
	if (closed.status !== 403)
		throw new Error("Registration reopened after restart");
	await closed.body?.cancel();
	const login = await post("/api/auth/login", {
		email: "me@example.com",
		password: "eight123",
	});
	const session = z.object({ token: z.string() }).safeParse(await login.json());
	if (!login.ok || !session.success)
		throw new Error("Created account cannot sign in after restart");
	const inbox = await fetch(base + "/inbox", {
		headers: { Cookie: "ep_session=" + session.data.token },
		redirect: "manual",
	});
	if (!inbox.ok || !(await inbox.text()).includes("me@example.com"))
		throw new Error("Created mailbox did not survive the server restart");
	state.db.exec("DELETE FROM domains");
	const missingDomain = await fetch(base + "/admin", {
		headers: { Cookie: "ep_session=" + session.data.token },
		redirect: "manual",
	});
	if (
		![302, 307].includes(missingDomain.status) ||
		missingDomain.headers.get("Location") !== "/setup"
	)
		throw new Error("Administrator without a domain did not enter onboarding");
	await missingDomain.body?.cancel();
	const onboarding = await fetch(base + "/setup", {
		headers: { Cookie: "ep_session=" + session.data.token },
		redirect: "manual",
	});
	if (
		!onboarding.ok ||
		!(await onboarding.text()).includes("Connect mail routing")
	)
		throw new Error("Original authenticated onboarding did not render");
	const domainAgain = await fetch(base + "/api/domains", {
		method: "POST",
		headers: {
			Origin: provider.publicOrigin,
			Authorization: "Bearer " + session.data.token,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			hostname: "example.com",
			enableRouting: true,
			enableSending: false,
		}),
	});
	const savedDomain = z
		.object({ domain: z.object({ id: z.string() }) })
		.safeParse(await domainAgain.json());
	if (!domainAgain.ok || !savedDomain.success)
		throw new Error("Onboarding domain step failed");
	const mailboxAgain = await fetch(base + "/api/mailboxes", {
		method: "POST",
		headers: {
			Origin: provider.publicOrigin,
			Authorization: "Bearer " + session.data.token,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			domainId: savedDomain.data.domain.id,
			localPart: "me",
			displayName: "me",
		}),
	});
	if (!mailboxAgain.ok)
		throw new Error(
			"Onboarding mailbox step failed: " + (await mailboxAgain.text()),
		);
	await mailboxAgain.body?.cancel();

	console.log(
		JSON.stringify(
			{
				originalSetupScreen: "passed",
				originalAliases: "passed",
				localChecks: "passed",
				setupToken: "passed",
				mxConsent: "passed",
				signedHealthCallbacks: "passed",
				failedSetupCleanup: "passed",
				stableRelayRetry: "passed",
				receiveOnly: "passed",
				restartAndLogin: "passed",
				authenticatedOnboarding: "passed",
				workerUploads: provider.uploads,
				externalRequests: 0,
			},
			null,
			2,
		),
	);
} finally {
	await stop();
	await provider.stop();
	await state.close();
	const stderr = (await Promise.all(errors)).join("\n");
	if (stderr.trim()) console.error(stderr);
}
