import { resolve } from "node:path";
import { deepStrictEqual } from "node:assert";
import { fixture } from "../tests/fixtures";
import { hash } from "../src/server/auth/service";
import {
	bulkSamples,
	bulkPath,
	bulkPayload,
	prepareBulkFixture,
	bulkSnapshot,
} from "../tests/bulk-contract-fixture";
import capture from "../tests/source-bulk-contracts.json";

const state = await fixture(),
	binary = resolve(process.argv[2] ?? "dist/mailrun-local"),
	publicBase = "https://bulk-fixture.example";
const tokens = { owner: crypto.randomUUID(), stranger: crypto.randomUUID() };
for (const [actor, token] of Object.entries(tokens))
	state.db
		.query(
			"INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,1)",
		)
		.run(
			`bulk-${actor}`,
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
		PORT: "0",
		HOST: "127.0.0.1",
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
				let text = "";
				while (!base) {
					const part = await reader.read();
					if (part.done) throw new Error("Bulk fixture exited during startup");
					text += new TextDecoder().decode(part.value);
					base = text.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? "";
				}
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Bulk fixture did not boot")),
					15000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
	let passed = 0;
	for (const sample of bulkSamples) {
		const expected = capture.cases.find((value) => value.name === sample.name);
		if (!expected) throw new Error("Missing original capture: " + sample.name);
		await prepareBulkFixture(state.db, state.directory, sample);
		const started = Math.floor(Date.now() / 1000),
			body = sample.rawBody ?? JSON.stringify(bulkPayload(sample));
		const response = await fetch(base + bulkPath(sample), {
			method: sample.method ?? "POST",
			headers: {
				Origin: publicBase,
				Authorization: "Bearer " + tokens[sample.actor],
				"Content-Type": "application/json",
			},
			...(sample.method === "GET" ? {} : { body }),
			signal: AbortSignal.timeout(60000),
		});
		if (response.status !== expected.status)
			throw new Error(
				`Compiled ${sample.name}: expected HTTP ${expected.status}, got ${response.status}`,
			);
		const actual = await bulkSnapshot(
			state.db,
			state.directory,
			sample,
			await response.json(),
			started,
		);
		const {
			name: _name,
			status: _status,
			requestSha256: _sha,
			...snapshot
		} = expected;
		deepStrictEqual(
			actual,
			snapshot,
			`Compiled source contract differs: ${sample.name}`,
		);
		passed++;
	}
	console.log(
		JSON.stringify(
			{
				binary,
				originalContracts: passed,
				responsesAndGrants: "passed",
				retentionAndAudit: "passed",
				rawMimeAndAttachmentObjects: "passed",
				folderDtosAndValidation: "passed",
				emptyFolderBatch: 100,
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
