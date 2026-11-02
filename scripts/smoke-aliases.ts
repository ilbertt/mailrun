import { resolve } from "node:path";
import { deepStrictEqual } from "node:assert";
import { fixture } from "../tests/fixtures";
import { hash } from "../src/server/auth/service";
import {
	aliasSamples,
	prepareAliasFixture,
	aliasRequest,
	aliasSnapshot,
} from "../tests/alias-contract-fixture";
import capture from "../tests/source-alias-contracts.json";

const state = await fixture(),
	binary = resolve(process.argv[2] ?? "dist/mailrun-local"),
	publicBase = "https://alias-fixture.example";
const tokens = { owner: crypto.randomUUID(), stranger: crypto.randomUUID() };
for (const [actor, token] of Object.entries(tokens))
	state.db
		.query(
			"INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,1)",
		)
		.run(
			"alias-" + actor,
			actor,
			await hash(token),
			Math.floor(Date.now() / 1000) + 900,
		);
const child = Bun.spawn([binary], {
	cwd: state.directory,
	env: {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		TMPDIR: process.env.TMPDIR,
		DATA_DIR: state.directory,
		HOST: "127.0.0.1",
		PORT: "0",
		APP_URL: publicBase,
		NODE_ENV: "production",
	},
	stdout: "pipe",
	stderr: "pipe",
});
const errors = new Response(child.stderr).text();
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
					if (part.done) throw new Error("Alias fixture exited during startup");
					output += new TextDecoder().decode(part.value);
					base = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? "";
				}
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Alias fixture did not boot")),
					15000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
	let passed = 0;
	const failures: string[] = [];
	for (const sample of aliasSamples) {
		const expected = capture.cases.find((item) => item.name === sample.name);
		if (!expected) throw new Error("Missing source capture");
		await prepareAliasFixture(state.db, sample);
		const started = Math.floor(Date.now() / 1000);
		const request = aliasRequest(sample, base, {
			Authorization: "Bearer " + tokens[sample.actor ?? "owner"],
		});
		// Session writes use the configured public origin behind the real HTTP server.
		request.headers.set("Origin", publicBase);
		const response = await fetch(request, {
			signal: AbortSignal.timeout(30000),
		});
		try {
			deepStrictEqual(
				await aliasSnapshot(state.db, response, started),
				expected.snapshot,
				sample.name,
			);
			passed++;
		} catch (error) {
			failures.push(sample.name);
			if (process.env.MAILRUN_ALIAS_TRACE) console.error(error);
		}
	}
	if (failures.length)
		throw new Error(
			JSON.stringify({ passed, failed: failures.length, cases: failures }),
		);
	console.log(
		JSON.stringify(
			{
				binary,
				originalAliasContracts: passed,
				sourceResponsesAndPersistedFields: "passed",
				aliasOrderAndDomains: "passed",
				managementPermissions: "passed",
				externalEmail: 0,
			},
			null,
			2,
		),
	);
} finally {
	child.kill("SIGTERM");
	await child.exited;
	const log = await errors;
	await state.close();
	if (log) console.error(log);
}
