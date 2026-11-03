import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { fixture, owner, stranger } from "../tests/fixtures";
import {
	prepareSourceUploads,
	verifyOriginalRecordFields,
} from "../tests/source-upload-fixture";
import capture from "../tests/source-features-capture.json";
import {
	sourceFeatureSession,
	comparableFeatureResponse,
	readFeatureBody,
} from "../tests/source-feature-requests";
import { deepStrictEqual } from "node:assert/strict";

const state = await fixture(),
	source = await prepareSourceUploads(state.directory, capture),
	destination = join(state.directory, "compiled-feature-import"),
	binary = resolve(process.argv[2] ?? "dist/mailrun-local"),
	origin = "http://source-feature.fixture";
const environment = {
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	TMPDIR: process.env.TMPDIR,
	NODE_ENV: "production",
	HOST: "127.0.0.1",
	PORT: "0",
	APP_URL: origin,
};
let child: ReturnType<typeof Bun.spawn> | undefined,
	base = "";
const stderr: Promise<string>[] = [];
async function stop() {
	if (!child) return;
	child.kill("SIGTERM");
	await child.exited;
	child = undefined;
}
async function start() {
	child = Bun.spawn([binary], {
		cwd: state.directory,
		env: { ...environment, DATA_DIR: destination },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (
		!child.stdout ||
		typeof child.stdout === "number" ||
		typeof child.stderr === "number"
	)
		throw new Error("Missing server pipes");
	stderr.push(new Response(child.stderr).text());
	const reader = child.stdout.getReader();
	let text = "",
		timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			(async () => {
				for (;;) {
					const next = await reader.read();
					if (next.done)
						throw new Error("Imported server exited before listening");
					text += new TextDecoder().decode(next.value);
					const url = text.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
					if (url) {
						base = url;
						return;
					}
				}
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Imported server did not boot")),
					15000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
}

try {
	const migration = Bun.spawn(
		[
			binary,
			"migrate-source",
			"--backup",
			source.backup,
			"--bucket",
			source.bucket,
			"--destination",
			destination,
		],
		{ cwd: state.directory, env: environment, stdout: "pipe", stderr: "pipe" },
	);
	const timer = setTimeout(() => migration.kill("SIGKILL"), 30000);
	try {
		const [exit, output, errors] = await Promise.all([
			migration.exited,
			new Response(migration.stdout).text(),
			new Response(migration.stderr).text(),
		]);
		assert.equal(exit, 0, errors);
		assert.equal(errors.trim(), "");
		z.object({
			jmapUploads: z.literal(3),
			driveParts: z.literal(1),
			objects: z.literal(12),
		}).parse(JSON.parse(output));
	} finally {
		clearTimeout(timer);
	}
	assert.equal(
		await Bun.file(join(state.directory, "data/mailflare.sqlite")).exists(),
		false,
		"Migration command started the normal app initialization",
	);
	process.env.DATA_DIR = destination;
	const records = new Database(join(destination, "mailflare.sqlite"), {
		readonly: true,
	});
	let originalFields: ReturnType<typeof verifyOriginalRecordFields>;
	try {
		originalFields = verifyOriginalRecordFields(records, capture.backup.tables);
	} finally {
		records.close();
	}

	const failures: string[] = [];
	let passed = 0;
	for (let restart = 0; restart < 2; restart++) {
		await start();
		for (const expected of capture.featureResponses) {
			const response = await fetch(base + expected.path, {
				headers: { Authorization: "Bearer " + sourceFeatureSession },
				signal: AbortSignal.timeout(30000),
			});
			try {
				assert.equal(response.status, expected.status);
				deepStrictEqual(
					comparableFeatureResponse(
						expected.path,
						await readFeatureBody(response),
						capture.backup.tables.mailboxes.map((row) => row.id),
					),
					comparableFeatureResponse(
						expected.path,
						expected.body,
						capture.backup.tables.mailboxes.map((row) => row.id),
					),
				);
				passed++;
			} catch (error) {
				failures.push(`${restart}:${expected.path}`);
				console.error(
					expected.path,
					error instanceof Error ? error.message : "mismatch",
				);
			}
		}
		await stop();
	}
	if (failures.length)
		throw new Error(
			JSON.stringify({ passed, failed: failures.length, cases: failures }),
		);
	console.log(
		JSON.stringify(
			{
				binary,
				originalFields,
				featureReads: passed,
				restarts: 1,
				externalEmail: 0,
			},
			null,
			2,
		),
	);
} finally {
	await stop();
	await state.close();
	const errors = (await Promise.all(stderr)).join("\n");
	if (errors.trim()) console.error(errors);
}
