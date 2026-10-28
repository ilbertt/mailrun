import { resolve } from "node:path";
import { fixture } from "../tests/fixtures";
import { hash } from "../src/server/auth/service";
import { seconds } from "../src/server/db";
import { signRelay } from "../src/shared/relay-signature";
import { startFixtureAgentProvider } from "../tests/agent-provider";
import { z } from "zod";
const state = await fixture(),
	provider = await startFixtureAgentProvider(state.directory),
	token = crypto.randomUUID(),
	secret = "synthetic-relay-secret",
	baseOrigin = "https://mailrun-agent-smoke.example",
	apiKey = "fixture-agent-token";
state.db
	.query(
		"INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES('agent-smoke','owner',?,?,?)",
	)
	.run(await hash(token), seconds() + 600, seconds());
state.db.exec(
	"UPDATE users SET spam_protection_enabled=0 WHERE id='owner'; INSERT INTO mailrun_installation VALUES('primary','account','zone','example.com','relay','https://mailrun-agent-smoke.example','synthetic-token','synthetic-relay-secret','fixture','ready',1)",
);
const binary = resolve(process.argv[2] ?? "dist/mailrun-local"),
	env = {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		TMPDIR: process.env.TMPDIR,
		DATA_DIR: state.directory,
		PORT: "0",
		HOST: "127.0.0.1",
		APP_URL: baseOrigin,
		NODE_ENV: "production",
		NODE_EXTRA_CA_CERTS: provider.cert,
	},
	child = Bun.spawn([binary], {
		cwd: state.directory,
		env,
		stdout: "pipe",
		stderr: "pipe",
	}),
	errors = new Response(child.stderr).text();
try {
	const reader = child.stdout.getReader(),
		initial = await reader.read(),
		base = new TextDecoder()
			.decode(initial.value)
			.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
	reader.releaseLock();
	if (!base) throw new Error("Agent smoke server did not start");
	const headers = {
		Cookie: `ep_session=${token}`,
		Origin: baseOrigin,
		"Content-Type": "application/json",
	};
	const api = async (path: string, method = "GET", body?: unknown) => {
		const response = await fetch(base + path, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const data: unknown = await response.json();
		if (!response.ok)
			throw new Error(
				`Agent API ${path} (${response.status}): ${JSON.stringify(data)}`,
			);
		return data;
	};
	const configured = await api("/api/admin/agent", "PUT", {
		provider: "compatible",
		preset: "custom",
		baseUrl: provider.url,
		apiKey,
		model: "fixture-model",
		rates: { "fixture-model": { input: 2, output: 4 } },
	});
	if (JSON.stringify(configured).includes(apiKey))
		throw new Error("Public configuration exposed provider credentials");
	const catalog = z
		.object({ models: z.array(z.object({ id: z.string() })) })
		.parse(
			await api("/api/admin/agent/models", "POST", {
				provider: "compatible",
				preset: "custom",
				baseUrl: provider.url,
			}),
		);
	if (!catalog.models.some((model) => model.id === "fixture-model"))
		throw new Error("TLS model catalog failed");
	const chat = async (text: string) => {
		const response = await fetch(base + "/api/agent/chat", {
			method: "POST",
			headers,
			body: JSON.stringify({
				mailboxId: "mailbox",
				text,
				currentMessageId: "message",
			}),
		});
		if (!response.ok)
			throw new Error("Compiled chat failed: " + (await response.text()));
		if (!response.headers.get("Content-Type")?.includes("application/x-ndjson"))
			throw new Error("Chat is not NDJSON");
		return (await response.text())
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	};
	const read = await chat("Read this email");
	if (
		!read.some(
			(event) =>
				event.type === "tool" &&
				event.state === "complete" &&
				event.result.id === "message",
		) ||
		read.at(-1)?.type !== "done"
	)
		throw new Error(
			"Compiled read/tool stream failed: " + JSON.stringify(read),
		);
	const draft = await chat("Draft a reply");
	const created = draft.find(
		(event) => event.type === "tool" && event.state === "complete",
	)?.result?.draftId;
	if (typeof created !== "string")
		throw new Error("Compiled reply draft tool failed");
	const changed = await chat("Mark this message read");
	const proposal = changed.find(
		(event) => event.type === "tool" && event.state === "complete",
	);
	if (!proposal?.recordId || proposal.result.status !== "pending_approval")
		throw new Error("Mail mutation was not proposed");
	if (
		state.db
			.query<{ read: number }, []>(
				"SELECT read FROM messages WHERE id='message'",
			)
			.get()?.read
	)
		throw new Error("Proposal changed mail before confirmation");
	await api("/api/agent/actions/confirm", "POST", {
		toolMessageId: proposal.recordId,
	});
	if (
		!state.db
			.query<{ read: number }, []>(
				"SELECT read FROM messages WHERE id='message'",
			)
			.get()?.read
	)
		throw new Error("Human action confirmation failed");
	for (const path of [
		"/agent",
		"/ai-usage",
		`/agent/review/not-a-real-review`,
	]) {
		const response = await fetch(base + path, {
			headers: { Cookie: `ep_session=${token}` },
			redirect: "manual",
		});
		if (response.status !== 200)
			throw new Error("Restored assistant route failed: " + path);
	}
	const usage = z
		.object({ totals: z.object({ requests: z.number() }) })
		.parse(await api("/api/admin/ai-usage"));
	if (usage.totals.requests < 6)
		throw new Error("Streaming usage was not recorded");
	await api("/api/agent/settings", "PUT", {
		mailboxId: "mailbox",
		enabled: true,
		modelId: "fixture-model",
		autoDraftEnabled: true,
		reviewerUserId: "owner",
		instructions: "Be concise.",
		dailyLimit: 25,
	});
	const raw = new TextEncoder().encode(
			"From: sender@example.org\r\nTo: hello@example.com\r\nMessage-ID: <agent-smoke@example.org>\r\nSubject: Automatic draft smoke\r\n\r\nWould Tuesday work?",
		),
		timestamp = String(Date.now()),
		signature = await signRelay(
			secret,
			timestamp,
			"sender@example.org",
			"hello@example.com",
			raw,
		);
	const incoming = await fetch(base + "/api/inbound", {
		method: "POST",
		headers: {
			"x-mailrun-from": "sender@example.org",
			"x-mailrun-to": "hello@example.com",
			"x-mailrun-timestamp": timestamp,
			"x-mailrun-signature": signature,
		},
		body: raw,
	});
	if (!incoming.ok) throw new Error("Signed automatic-draft ingress failed");
	const deadline = Date.now() + 5000;
	while (
		state.db
			.query<{ status: string }, []>("SELECT status FROM agent_jobs LIMIT 1")
			.get()?.status !== "completed" &&
		Date.now() < deadline
	)
		await Bun.sleep(20);
	if (
		state.db
			.query<{ status: string }, []>("SELECT status FROM agent_jobs LIMIT 1")
			.get()?.status !== "completed"
	)
		throw new Error("Eager automatic drafting did not complete");
	child.kill();
	await child.exited;
	state.db.exec(
		"INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,text_body,status,created_at) VALUES('cron-source','owner','mailbox','inbound','sender@example.org','hello@example.com','Cron draft','Another request','received',2); INSERT INTO agent_jobs(id,mailbox_id,source_message_id,reviewer_user_id,status,next_attempt_at,created_at) VALUES('cron-agent','mailbox','cron-source','owner','pending',0,2)",
	);
	const cron = Bun.spawn([binary, "jobs", "maintenance"], {
			cwd: state.directory,
			env,
			stdout: "pipe",
			stderr: "pipe",
		}),
		cronOutput = await new Response(cron.stdout).text(),
		cronError = await new Response(cron.stderr).text();
	if ((await cron.exited) !== 0)
		throw new Error("Agent cron failed " + cronError);
	if (
		!cronOutput.includes("maintenance") ||
		state.db
			.query<{ status: string }, []>(
				"SELECT status FROM agent_jobs WHERE id='cron-agent'",
			)
			.get()?.status !== "completed"
	)
		throw new Error("Persisted automatic job did not recover through cron");
	if (state.db.query("SELECT id FROM outbound_jobs").all().length)
		throw new Error("Assistant draft unexpectedly queued email delivery");
	console.log(
		JSON.stringify(
			{
				binary,
				httpsProviderCatalog: "passed",
				chatAndTools: "passed",
				humanActionConfirmation: "passed",
				providerSecretsMasked: "passed",
				originalAssistantRoutes: "passed",
				usageAccounting: "passed",
				signedAutoDraftIngress: "passed",
				eagerGeneration: "passed",
				cronRecovery: "passed",
				noAutomaticMailDispatch: "passed",
				providerCalls: provider.calls.length,
			},
			null,
			2,
		),
	);
} finally {
	child.kill();
	await child.exited;
	await errors;
	await provider.stop();
	await state.close();
}
