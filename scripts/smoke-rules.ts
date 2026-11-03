import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";
import { deepStrictEqual } from "node:assert";
import { fixture } from "../tests/fixtures";
import { hash } from "../src/server/auth/service";
import {
	ruleSamples,
	prepareRuleFixture,
	ruleRequest,
	ruleSnapshot,
} from "../tests/rule-contract-fixture";
import capture from "../tests/source-rule-contracts.json";
import { writeAvatarFixturePreload } from "../tests/avatar-provider";
import { signRelay } from "../src/shared/relay-signature";

const constrained = process.env.MAILRUN_RULE_CONTAINER === "1";
if (constrained && process.platform !== "linux")
	throw new Error("The constrained check requires native Linux Docker");
if (constrained && !Bun.which("docker"))
	throw new Error("Docker is required for the constrained rule check");
const state = await fixture(),
	binary = resolve(process.argv[2] ?? "dist/mailrun-local"),
	publicBase = "https://rule-fixture.example";
const tokens = { owner: crypto.randomUUID(), stranger: crypto.randomUUID() };
const preload = await writeAvatarFixturePreload(state.directory),
	secret = crypto.randomUUID();
const container = "mailrun-rules-" + crypto.randomUUID().slice(0, 12);
state.db.exec("PRAGMA busy_timeout=5000");
for (const [actor, token] of Object.entries(tokens))
	state.db
		.query(
			"INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,1)",
		)
		.run(
			"rule-" + actor,
			actor,
			await hash(token),
			Math.floor(Date.now() / 1000) + 900,
		);
const serverEnvironment = {
	PATH: process.env.PATH,
	HOME: constrained ? "/" : process.env.HOME,
	TMPDIR: constrained ? "/tmp" : process.env.TMPDIR,
	DATA_DIR: state.directory,
	HOST: "127.0.0.1",
	PORT: "0",
	APP_URL: publicBase,
	NODE_ENV: "production",
	BUN_OPTIONS: "--preload " + preload.path,
};
const command = constrained
	? [
			"docker",
			"run",
			"--name",
			container,
			"--network",
			"host",
			"--cpus",
			"1",
			"--memory",
			"256m",
			"--memory-swap",
			"256m",
			"--read-only",
			"--user",
			`${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
			"--tmpfs",
			"/tmp:rw,noexec,nosuid,size=67108864",
			"--volume",
			`${state.directory}:${state.directory}`,
			"--volume",
			`${binary}:${binary}:ro`,
			"--workdir",
			"/",
			...Object.entries(serverEnvironment)
				.filter(
					(entry): entry is [string, string] => typeof entry[1] === "string",
				)
				.flatMap(([key, value]) => ["--env", key + "=" + value]),
			"debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3",
			binary,
		]
	: [binary];
const child = Bun.spawn(command, {
	cwd: state.directory,
	env: constrained ? process.env : serverEnvironment,
	stdout: "pipe",
	stderr: "pipe",
});
const errors = new Response(child.stderr).text();
let complete = false;
try {
	const reader = child.stdout.getReader();
	let base = "",
		timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			(async () => {
				let output = "";
				while (!base) {
					const part = await reader.read();
					if (part.done) throw new Error("Rule fixture exited during startup");
					output += new TextDecoder().decode(part.value);
					base = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? "";
				}
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Rule fixture did not boot")),
					constrained ? 120000 : 15000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
	let passed = 0;
	const failures: string[] = [];
	for (const sample of ruleSamples) {
		const expected = capture.cases.find((item) => item.name === sample.name);
		if (!expected) throw new Error("Missing source capture");
		await prepareRuleFixture(state.db, sample);
		const started = Math.floor(Date.now() / 1000);
		const request = ruleRequest(sample, base, {
			Authorization: "Bearer " + tokens[sample.actor ?? "owner"],
		});
		// Session writes use the configured public origin behind the real HTTP server.
		request.headers.set("Origin", publicBase);
		const response = await fetch(request, {
			signal: AbortSignal.timeout(30000),
		});
		try {
			deepStrictEqual(
				await ruleSnapshot(state.db, response, started),
				expected.snapshot,
				sample.name,
			);
			passed++;
		} catch (error) {
			failures.push(sample.name);
			if (process.env.MAILRUN_RULE_TRACE) console.error(error);
		}
	}
	if (failures.length)
		throw new Error(
			JSON.stringify({ passed, failed: failures.length, cases: failures }),
		);
	if (!existsSync(preload.marker))
		throw new Error("Avatar network fixture did not load");
	prepareRuleFixture(state.db, {
		name: "intake",
		scope: "domain",
		method: "GET",
	});
	state.db.exec(
		"DELETE FROM routing_rules; UPDATE users SET spam_protection_enabled=0; INSERT INTO mailrun_installation(id,account_id,zone_id,hostname,worker_name,public_origin,api_token,relay_secret,relay_version,phase,updated_at) VALUES('primary','account','zone','example.com','fixture-relay','https://rule-fixture.example','synthetic-token','placeholder','fixture','ready',1)",
	);
	state.db.query("UPDATE mailrun_installation SET relay_secret=?").run(secret);
	async function api(path: string, method: string, body?: unknown) {
		const r = await fetch(base + path, {
			method,
			headers: {
				Authorization: "Bearer " + tokens.owner,
				Origin: publicBase,
				"Content-Type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (!r.ok)
			throw new Error(
				"Rule setup failed: " + r.status + " " + (await r.text()),
			);
		return (await r.json()) as unknown;
	}
	async function intake(
		from: string,
		subject: string,
		text = "Synthetic rule execution",
	) {
		const raw = new TextEncoder().encode(
				`From: ${from}\r\nTo: hello@example.com\r\nSubject: ${subject}\r\nMessage-ID: <${crypto.randomUUID()}@example.invalid>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}`,
			),
			timestamp = String(Date.now());
		return fetch(base + "/api/inbound", {
			method: "POST",
			headers: {
				"X-Mailrun-From": from,
				"X-Mailrun-To": "hello@example.com",
				"X-Mailrun-Relay": "2",
				"X-Mailrun-Timestamp": timestamp,
				"X-Mailrun-Signature": await signRelay(
					secret,
					timestamp,
					from,
					"hello@example.com",
					raw,
				),
			},
			body: raw,
			signal: AbortSignal.timeout(15000),
		});
	}
	const nested = {
		domainId: "domain",
		matchField: "sender",
		matchOperator: "regex",
		matchValue: "^(a+)+@example\\.net$",
		action: "reject",
		rejectReason: "nested-match",
	};
	const created = z
		.object({ id: z.string() })
		.parse(await api("/api/routing-rules/domain", "POST", nested));
	let delivered = await intake("aaaa@example.net", "nested-accepted");
	deepStrictEqual(delivered.status, 200);
	deepStrictEqual(await delivered.json(), {
		action: "reject",
		reason: "nested-match",
	});
	deepStrictEqual(
		state.db
			.query("SELECT match_count FROM routing_rules WHERE id=?")
			.get(created.id),
		{ match_count: 1 },
	);
	await api("/api/routing-rules/domain/" + created.id, "PATCH", {
		...nested,
		matchValue: "^(a+)+b@example\\.net$",
	});
	const timeoutStarted = performance.now(),
		pending = intake("a".repeat(60) + "x@example.net", "regex-timeout");
	await Bun.sleep(20);
	const probeStarted = performance.now();
	const probe = await fetch(base + "/api/auth/me", {
		headers: { Authorization: "Bearer " + tokens.owner },
		signal: AbortSignal.timeout(5000),
	});
	const authProbeMs = performance.now() - probeStarted;
	deepStrictEqual(probe.status, 200);
	await probe.body?.cancel();
	const timedOut = await pending;
	deepStrictEqual(timedOut.status, 503);
	await timedOut.body?.cancel();
	const timeoutWallMs = performance.now() - timeoutStarted;
	deepStrictEqual(
		state.db
			.query(
				"SELECT count(*) AS count FROM messages WHERE subject='regex-timeout'",
			)
			.get(),
		{ count: 0 },
	);
	await api("/api/routing-rules/domain/" + created.id, "PATCH", {
		...nested,
		matchValue: "^(a+)+@example[.]net$",
	});
	delivered = await intake("aaaa@example.net", "nested-recovery");
	deepStrictEqual(delivered.status, 200);
	deepStrictEqual(await delivered.json(), {
		action: "reject",
		reason: "nested-match",
	});
	await api("/api/routing-rules/domain/" + created.id, "DELETE");
	const inbox = z.object({ id: z.string() }).parse(
		await api("/api/routing-rules", "POST", {
			mailboxId: "mailbox",
			matchField: "title",
			matchOperator: "contains",
			matchValue: "Invoice",
			destination: "folder:target-folder",
		}),
	);
	delivered = await intake("sender@example.net", "Invoice folder");
	const stored = z
		.object({ action: z.literal("store"), messageId: z.string() })
		.parse(await delivered.json());
	deepStrictEqual(delivered.status, 200);
	deepStrictEqual(
		state.db
			.query("SELECT mailbox_id,folder_id,status FROM messages WHERE id=?")
			.get(stored.messageId),
		{ mailbox_id: "mailbox", folder_id: "target-folder", status: "received" },
	);
	state.db
		.query(
			"UPDATE routing_rules SET match_field='content',match_operator='regex',match_value='late-marker',pattern='late-marker',action='spam',folder_id=NULL WHERE id=?",
		)
		.run(inbox.id);
	delivered = await intake(
		"sender@example.net",
		"Legacy full regex",
		"x".repeat(4_000_003) + "late-marker",
	);
	const large = z
		.object({ action: z.literal("store"), messageId: z.string() })
		.parse(await delivered.json());
	deepStrictEqual(delivered.status, 200);
	deepStrictEqual(
		state.db
			.query("SELECT status FROM messages WHERE id=?")
			.get(large.messageId),
		{ status: "spam" },
	);
	const unusedDirectory = join(
			state.directory,
			"regex-cli-must-not-create-data",
		),
		frame = Buffer.concat([
			Buffer.from(JSON.stringify({ pattern: "(a+)+$", codeUnits: 4 }) + "\n"),
			Buffer.from("aaaa", "utf16le"),
		]);
	const cli = Bun.spawn([binary, "regex-match"], {
		cwd: state.directory,
		env: {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			TMPDIR: process.env.TMPDIR,
			DATA_DIR: unusedDirectory,
			NIBRUN_DATA_DIR: unusedDirectory,
		},
		stdin: frame,
		stdout: "pipe",
		stderr: "pipe",
		timeout: 5000,
		killSignal: "SIGKILL",
	});
	const cliBody = await new Response(cli.stdout).text(),
		cliErrors = await new Response(cli.stderr).text();
	deepStrictEqual(await cli.exited, 0, cliErrors);
	deepStrictEqual(cliBody, "ready\ntrue");
	deepStrictEqual(existsSync(unusedDirectory), false);
	let memory: unknown = null;
	if (constrained) {
		const measurement = Bun.spawnSync(
			[
				"docker",
				"exec",
				container,
				"cat",
				"/sys/fs/cgroup/memory.peak",
				"/sys/fs/cgroup/memory.events",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		if (measurement.exitCode)
			throw new Error("Could not read container memory counters");
		const lines = measurement.stdout.toString().trim().split("\n"),
			peakBytes = z.coerce.number().int().positive().parse(lines[0]),
			oomKills = z.coerce
				.number()
				.int()
				.nonnegative()
				.parse(
					lines.find((line) => line.startsWith("oom_kill "))?.split(" ")[1],
				);
		deepStrictEqual(oomKills, 0);
		if (peakBytes > 256 * 1024 * 1024)
			throw new Error("Constrained memory limit exceeded");
		memory = { peakBytes, oomKills, limitBytes: 256 * 1024 * 1024, cpu: 1 };
	}
	complete = true;
	console.log(
		JSON.stringify(
			{
				binary,
				originalRuleContracts: passed,
				sourceResponsesAndPersistedFields: "passed",
				ruleOrderAndDestinations: "passed",
				currentGrantsAndDelegation: "passed",
				compiledNestedRegexIngress: "passed",
				deadline503WithoutMessageCommit: "passed",
				afterDeadlineRecovery: "passed",
				fourMegabyteLegacyRegexInbox: "passed",
				cliWithoutDatabaseOrCron: "passed",
				authProbeMs: Number(authProbeMs.toFixed(2)),
				timeoutWallMs: Number(timeoutWallMs.toFixed(2)),
				memory,
				externalEmail: 0,
			},
			null,
			2,
		),
	);
} finally {
	if (constrained && !complete) {
		const detail = Bun.spawnSync(
			["docker", "inspect", "--format", "{{json .State}}", container],
			{ stdout: "pipe", stderr: "ignore" },
		);
		const counters = Bun.spawnSync(
			[
				"docker",
				"exec",
				container,
				"cat",
				"/sys/fs/cgroup/memory.peak",
				"/sys/fs/cgroup/memory.events",
			],
			{ stdout: "pipe", stderr: "ignore" },
		);
		console.error(
			"Constrained rule fixture diagnostics",
			detail.stdout.toString().trim(),
			counters.stdout.toString().trim(),
		);
	}
	if (constrained)
		Bun.spawnSync(["docker", "stop", "--time", "3", container], {
			stdout: "ignore",
			stderr: "ignore",
		});
	else child.kill("SIGTERM");
	await child.exited;
	if (constrained)
		Bun.spawnSync(["docker", "rm", "--force", container], {
			stdout: "ignore",
			stderr: "ignore",
		});
	const log = await errors;
	await state.close();
	if (log) console.error(log);
}
