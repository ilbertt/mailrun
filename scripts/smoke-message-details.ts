import { resolve } from "node:path";
import { deepStrictEqual } from "node:assert";
import { fixture } from "../tests/fixtures";
import { hash } from "../src/server/auth/service";
import {
	detailSamples,
	detailPath,
	prepareDetailFixture,
	detailSnapshot,
	sourceComparableDetailSnapshot,
} from "../tests/message-detail-fixture";
import capture from "../tests/source-message-details.json";

const state = await fixture(),
	binary = resolve(process.argv[2] ?? "dist/mailrun-local"),
	publicBase = "https://read-fixture.example";
const tokens = { owner: crypto.randomUUID(), stranger: crypto.randomUUID() };
for (const [actor, token] of Object.entries(tokens))
	state.db
		.query(
			"INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,1)",
		)
		.run(
			`read-${actor}`,
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
					if (part.done) throw new Error("Read fixture exited during startup");
					text += new TextDecoder().decode(part.value);
					base = text.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? "";
				}
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Read fixture did not boot")),
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
	for (const sample of detailSamples) {
		const expected = capture.cases.find((value) => value.name === sample.name);
		if (!expected) throw new Error("Missing original capture: " + sample.name);
		await prepareDetailFixture(state.db, state.directory, sample);
		if (process.env.MAILRUN_DETAIL_TRACE) console.log(sample.name);
		const response = await fetch(base + detailPath(sample), {
			headers: { Authorization: "Bearer " + tokens[sample.actor ?? "owner"] },
			signal: AbortSignal.timeout(60000),
		});
		const { name: _name, ...snapshot } = expected;
		try {
			deepStrictEqual(
				await detailSnapshot(response),
				sourceComparableDetailSnapshot(snapshot),
				`Compiled detail contract differs: ${sample.name}`,
			);
		} catch (error) {
			if (process.env.MAILRUN_DETAIL_TRACE)
				console.error(
					sample.name,
					error instanceof Error ? error.message : "mismatch",
				);
			failures.push(sample.name);
			continue;
		}
		passed++;
	}

	// This is an explicit native permission boundary, outside the source captures.
	const privateSample = {
		name: "native-private-draft",
		endpoint: "detail",
		id: "draft",
		actor: "stranger",
		permission: "full_access",
	} as const;
	await prepareDetailFixture(state.db, state.directory, privateSample);
	state.db.exec(
		"UPDATE message_attachments SET message_id='draft' WHERE id='read-attachment'",
	);
	for (const endpoint of [
		"detail",
		"thread",
		"metadata",
		"attachment",
	] as const) {
		const response = await fetch(
			base + detailPath({ ...privateSample, endpoint }),
			{
				headers: { Authorization: "Bearer " + tokens.stranger },
				signal: AbortSignal.timeout(10000),
			},
		);
		deepStrictEqual(
			response.status,
			404,
			`Native private draft exposed through ${endpoint}`,
		);
		await response.arrayBuffer();
	}

	if (failures.length)
		throw new Error(
			JSON.stringify({ passed, failed: failures.length, cases: failures }),
		);

	console.log(
		JSON.stringify(
			{
				binary,
				originalContracts: passed,
				nativeDraftReadDenials: 4,
				detailBodiesAndMetadata: "passed",
				threadContentsAndContacts: "passed",
				downloadBytesTypesAndDisposition: "passed",
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
