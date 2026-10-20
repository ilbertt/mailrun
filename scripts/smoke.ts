import { resolve } from "node:path";
import { fixture } from "../tests/fixtures";
import { seconds } from "../src/server/db";
import { hash } from "../src/server/auth/service";
import bcrypt from "bcryptjs";
import { toJSON } from "seroval";

const state = await fixture();
const token = crypto.randomUUID();
const password = crypto.randomUUID();
state.db.query("UPDATE users SET password_hash=? WHERE id='owner'").run(await bcrypt.hash(password, 4));
state.db.query("INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES ('smoke','owner',?,?,?)").run(await hash(token), seconds() + 300, seconds());
const binary = resolve(process.argv[2] ?? "dist/mailrun-local");
const publicBase = "https://mailrun-smoke.example";
const child = Bun.spawn([binary], {
	cwd: state.directory,
	env: { ...process.env, DATA_DIR: state.directory, PORT: "0", HOST: "127.0.0.1", APP_URL: publicBase, NODE_ENV: "production" },
	stdout: "pipe", stderr: "pipe",
});
try {
	const reader = child.stdout.getReader();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const first = await Promise.race([
		reader.read(),
		new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Server did not boot within 10 seconds")), 10_000); }),
	]);
	clearTimeout(timer);
	const log = new TextDecoder().decode(first.value);
	const base = log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
	if (!base) throw new Error(`Unexpected startup output: ${log}`);
	reader.releaseLock();
	let loginId: string | undefined;
	for await (const path of new Bun.Glob("dist/server/assets/functions-*.js").scan()) {
		const source = await Bun.file(path).text();
		loginId ??= source.match(/var loginFn_createServerFn_handler = createServerRpc\(\{\s*id:\s*"([^"]+)"/)?.[1];
	}
	if (!loginId) throw new Error("Login server function missing from the build");
	const payload = JSON.stringify(toJSON({ data: { email: "owner@example.com", password } }));
	const csrf = await fetch(`${base}/_serverFn/${loginId}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://untrusted.example" }, body: payload });
	if (csrf.status !== 403) throw new Error(`Cross-origin mutation returned ${csrf.status}`);
	const login = await fetch(`${base}/_serverFn/${loginId}`, {
		method: "POST", headers: { "Content-Type": "application/json", Origin: publicBase, "x-tsr-serverfn": "true" }, body: payload,
	});
	const cookie = login.headers.get("set-cookie");
	if (!login.ok || !cookie?.includes("ep_session=") || !cookie.toLowerCase().includes("httponly")) throw new Error(`HTTP login failed: ${login.status} ${await login.text()}`);
	const loggedIn = await fetch(`${base}/inbox`, { headers: { Cookie: cookie.split(";")[0] ?? "" } });
	if (!loggedIn.ok || !(await loggedIn.text()).includes("A searchable subject")) throw new Error("HTTP login session was not accepted");
	const health = await fetch(`${base}/api/health`);
	if (!health.ok) throw new Error(`Health failed: ${health.status} ${await health.text()}`);
	const anonymous = await fetch(`${base}/inbox`, { redirect: "manual" });
	if (anonymous.status !== 307 && anonymous.status !== 302) throw new Error(`Anonymous inbox was not redirected: ${anonymous.status}`);
	const authenticated = await fetch(`${base}/inbox`, { headers: { Cookie: `ep_session=${token}` } });
	const html = await authenticated.text();
	if (!authenticated.ok || !html.includes("A searchable subject")) throw new Error(`Inbox SSR failed: ${authenticated.status} ${html.slice(0, 1000)}`);
	if (authenticated.headers.get("cache-control") !== "private, no-store") throw new Error("Private inbox is cacheable");
	const asset = html.match(/(?:src|href)="(\/assets\/[^"]+\.js)"/)?.[1];
	if (!asset) throw new Error("No client asset in rendered page");
	const response = await fetch(base + asset);
	if (!response.ok) throw new Error("Embedded asset missing");
	if (!response.headers.get("content-type")?.includes("javascript")) throw new Error("Embedded JavaScript has the wrong content type");
	const etag = response.headers.get("etag");
	const conditional = await fetch(base + asset, { headers: { "If-None-Match": etag ?? "" } });
	if (conditional.status !== 304) throw new Error("Conditional asset request did not return 304");
	const deniedDownload = await fetch(`${base}/api/messages/message/original`);
	if (deniedDownload.status !== 401) throw new Error(`Unauthenticated download returned ${deniedDownload.status}`);
	const task = Bun.spawn([binary, "jobs", "maintenance"], { cwd: state.directory, env: { ...process.env, DATA_DIR: state.directory }, stdout: "pipe", stderr: "pipe" });
	const taskExit = await task.exited;
	const taskOutput = await new Response(task.stdout).text();
	if (taskExit !== 0 || !taskOutput.includes('"job":"maintenance"')) throw new Error(`Compiled cron task failed: ${taskOutput} ${await new Response(task.stderr).text()}`);
	const registeredTask = Bun.spawn([binary, "run", "--cron-title=mailrun-maintenance", "--cron-period=*/5 * * * *"], {
		cwd: state.directory, env: { ...process.env, DATA_DIR: state.directory }, stdout: "pipe", stderr: "pipe",
	});
	if (await registeredTask.exited !== 0 || !(await new Response(registeredTask.stdout).text()).includes('"job":"maintenance"')) throw new Error("Bun cron argument dispatch failed");
	const rssProcess = Bun.spawn(["ps", "-o", "rss=", "-p", String(child.pid)], { stdout: "pipe" });
	const rssKiB = Number((await new Response(rssProcess.stdout).text()).trim());
	console.log(JSON.stringify({ binary, health: "passed", csrfProtection: "passed", serverFunctionLogin: "passed", unauthenticatedRedirect: "passed", authenticatedInboxSsr: "passed", embeddedAssets: "passed", conditionalAssets: "passed", standaloneCwd: "passed", taskCommand: "passed", bunCronDispatch: "passed", downloadAuthorization: "passed", rssMiB: Math.round(rssKiB / 1024) }, null, 2));
} finally {
	child.kill();
	await child.exited;
	const error = await new Response(child.stderr).text();
	if (error.trim()) console.error(error);
	await state.close();
}
