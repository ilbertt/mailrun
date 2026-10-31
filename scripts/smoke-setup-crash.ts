import { resolve } from "node:path";
import { z } from "zod";
import { fixture } from "../tests/fixtures";
import {
	startFixtureSetupProvider,
	writeSetupFixturePreload,
} from "../tests/setup-provider";

const binary = resolve(process.argv[2] ?? "dist/mailrun-local");
const stages = [
	"account-claimed",
	"installation-saved",
	"worker-published",
	"domain-pending",
	"catch-all-published",
	"sender-published",
] as const;
const results: {
	stage: string;
	sending: boolean;
	foreignMx: boolean;
	recovery: string;
	workerReused: boolean;
}[] = [];
for (const stage of stages)
	for (const enableSending of [false, true])
		for (const foreignMx of [false, true]) {
			if (stage === "sender-published" && !enableSending) continue;
			const state = await fixture();
			state.db.exec("DELETE FROM users WHERE role='admin'");
			const legacyAccount = state.db
				.query("SELECT * FROM users WHERE id='stranger'")
				.get();
			const reached = Promise.withResolvers<void>(),
				release = Promise.withResolvers<void>();
			let paused = false;
			const provider = await startFixtureSetupProvider(
				state.directory,
				async (url, request) => {
					if (paused) return;
					const users = state.db
						.query("SELECT count(*) AS count FROM users WHERE role='admin'")
						.get() as { count: number };
					const installation = state.db
						.query("SELECT worker_name,phase FROM mailrun_installation")
						.get() as { worker_name: string; phase: string } | null;
					const domain = state.db.query("SELECT status FROM domains").get() as {
						status: string;
					} | null;
					const matches =
						stage === "account-claimed"
							? users.count === 1 &&
								!installation &&
								url.pathname === "/client/v4/zones"
							: stage === "installation-saved"
								? installation?.phase === "saved" &&
									url.pathname === "/api/relay-health"
								: stage === "worker-published"
									? request.method === "PUT" &&
										/\/workers\/scripts\/[^/]+$/.test(url.pathname)
									: stage === "domain-pending"
										? domain?.status === "pending" &&
											url.pathname.endsWith("/email/routing")
										: stage === "catch-all-published"
											? request.method === "PUT" &&
												url.pathname.endsWith("/rules/catch_all")
											: request.method === "POST" &&
												url.pathname.endsWith("/email/sending/subdomains");
					if (matches) {
						paused = true;
						reached.resolve();
						await release.promise;
					}
				},
			);
			if (foreignMx)
				provider.cf.addRecord({
					type: "MX",
					name: "example.com",
					content: "previous-mail.example.net",
					priority: 10,
				});
			const preload = await writeSetupFixturePreload(
				state.directory,
				provider.url,
			);
			const setupToken = crypto.randomUUID();
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
					throw new Error("Crash fixture output pipes are unavailable");
				errors.push(new Response(child.stderr).text());
				const reader = child.stdout.getReader();
				let output = "";
				const timer = setTimeout(() => child?.kill("SIGKILL"), 15_000);
				try {
					for (;;) {
						const part = await reader.read();
						if (part.done)
							throw new Error("Crash fixture server did not start");
						output += new TextDecoder().decode(part.value);
						const address = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
						if (address) {
							base = address;
							break;
						}
					}
				} finally {
					clearTimeout(timer);
					reader.releaseLock();
				}
				provider.setAppBase(base);
			}
			async function stop(signal: "SIGKILL" | "SIGTERM" = "SIGTERM") {
				if (!child) return;
				child.kill(signal);
				await child.exited;
				child = undefined;
			}
			async function call(
				path: string,
				body?: unknown,
				token?: string,
				method = "POST",
			) {
				return fetch(base + path, {
					method,
					redirect: "manual",
					headers: {
						Origin: provider.publicOrigin,
						"Content-Type": "application/json",
						"X-Mailrun-Setup-Token": setupToken,
						...(token
							? {
									Authorization: "Bearer " + token,
									Cookie: "ep_session=" + token,
								}
							: {}),
					},
					body: body === undefined ? undefined : JSON.stringify(body),
				});
			}
			try {
				await start();
				const registration = call("/api/auth/register", {
					domain: "example.com",
					username: "me",
					password: "crash-fixture-password",
					resetEmail: "recovery@example.org",
					setupToken,
					enableSending,
					replaceMxRecords: foreignMx,
				}).then(
					(response) => ({ response }),
					(error) => ({ error }),
				);
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						reached.promise,
						registration.then(() => {
							throw new Error("Registration ended before " + stage);
						}),
						new Promise<never>((_, reject) => {
							timer = setTimeout(
								() => reject(new Error("Checkpoint not reached: " + stage)),
								20_000,
							);
						}),
					]);
				} finally {
					clearTimeout(timer);
				}
				const before = state.db
					.query("SELECT worker_name,relay_secret FROM mailrun_installation")
					.get();
				await stop("SIGKILL");
				release.resolve();
				await registration;
				await start();
				const login = await call("/api/auth/login", {
					email: "me@example.com",
					password: "crash-fixture-password",
				});
				const session = z
					.object({ token: z.string() })
					.parse(await login.json());
				if (!login.ok)
					throw new Error(
						"Committed administrator could not sign in after " + stage,
					);
				const domains = z
					.object({
						domains: z.array(z.object({ id: z.string(), status: z.string() })),
					})
					.parse(
						await (
							await call("/api/domains", undefined, session.token, "GET")
						).json(),
					).domains;
				let domainId = domains[0]?.id;
				if (!domainId) {
					const page = await call("/setup", undefined, session.token, "GET");
					if (!page.ok || !(await page.text()).includes("Connect mail routing"))
						throw new Error(
							"Original onboarding was unavailable after " + stage,
						);
					const domain = await call(
						"/api/domains",
						{
							hostname: "example.com",
							enableRouting: true,
							enableSending,
							replaceMxRecords: foreignMx,
						},
						session.token,
					);
					if (!domain.ok)
						throw new Error(
							"Onboarding could not recover domain: " + (await domain.text()),
						);
					domainId = z
						.object({ domain: z.object({ id: z.string() }) })
						.parse(await domain.json()).domain.id;
					const mailbox = await call(
						"/api/mailboxes",
						{ domainId, localPart: "me", displayName: "me" },
						session.token,
					);
					if (!mailbox.ok)
						throw new Error(
							"Onboarding could not recover mailbox: " + (await mailbox.text()),
						);
				} else {
					const page = await call("/domains", undefined, session.token, "GET");
					if (!page.ok || !(await page.text()).includes("Domains"))
						throw new Error("Original domain repair screen was unavailable");
					let repair = await call(
						`/api/domains/${domainId}/receiving/cloudflare`,
						{ replaceMx: false },
						session.token,
					);
					if (repair.status === 409 && foreignMx) {
						const error = await repair.json();
						if (error.code !== "MX_CONFLICT")
							throw new Error("Unexpected recovery conflict");
						repair = await call(
							`/api/domains/${domainId}/receiving/cloudflare`,
							{ replaceMx: true },
							session.token,
						);
					}
					if (!repair.ok)
						throw new Error(
							"Domain receiving repair failed: " + (await repair.text()),
						);
				}
				if (enableSending) {
					const sending = await call(
						`/api/domains/${domainId}/sending`,
						{ provider: "cloudflare" },
						session.token,
						"PUT",
					);
					const result = await sending.json();
					if (!sending.ok || result.warning)
						throw new Error("Sending repair failed: " + JSON.stringify(result));
				}
				const capability = z
					.object({
						routing_enabled: z.literal(1),
						sending_enabled: z.number(),
						sending_requested: z.number(),
					})
					.parse(
						state.db
							.query(
								"SELECT routing_enabled,sending_enabled,sending_requested FROM domains",
							)
							.get(),
					);
				if (
					Boolean(capability.sending_enabled) !== enableSending ||
					Boolean(capability.sending_requested) !== enableSending
				)
					throw new Error("Recovery changed requested sending capability");
				const after = state.db
					.query("SELECT worker_name,relay_secret FROM mailrun_installation")
					.get();
				if (before && JSON.stringify(before) !== JSON.stringify(after))
					throw new Error("Recovery changed the saved Worker identity");
				const counts = state.db
					.query(
						"SELECT (SELECT count(*) FROM users) AS users,(SELECT count(*) FROM domains WHERE routing_enabled=1) AS domains,(SELECT count(*) FROM mailboxes) AS mailboxes",
					)
					.get();
				if (
					JSON.stringify(counts) !==
					JSON.stringify({ users: 2, domains: 1, mailboxes: 1 })
				)
					throw new Error(
						"Recovery duplicated or lost local records: " +
							JSON.stringify(counts),
					);
				if (
					state.db.query("PRAGMA foreign_key_check").all().length ||
					JSON.stringify(state.db.query("PRAGMA integrity_check").get()) !==
						JSON.stringify({ integrity_check: "ok" })
				)
					throw new Error("Crash recovery failed SQLite integrity");
				if (
					JSON.stringify(
						state.db.query("SELECT * FROM users WHERE id='stranger'").get(),
					) !== JSON.stringify(legacyAccount)
				)
					throw new Error("Recovery changed an unrelated existing account");
				const inbox = await call("/inbox", undefined, session.token, "GET");
				if (!inbox.ok || !(await inbox.text()).includes("me@example.com"))
					throw new Error("Recovered inbox did not render");
				results.push({
					stage,
					sending: enableSending,
					foreignMx,
					recovery: domains.length
						? "original domain receiving setup"
						: "original authenticated onboarding",
					workerReused:
						!before || JSON.stringify(before) === JSON.stringify(after),
				});
			} finally {
				release.resolve();
				await stop();
				await provider.stop();
				await state.close();
				const stderr = (await Promise.all(errors)).join("\n");
				if (stderr.trim()) console.error(stderr);
			}
		}
console.log(
	JSON.stringify({ abruptProcessKill: results, externalRequests: 0 }, null, 2),
);
