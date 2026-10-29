import { resolve, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { getMigrations } from "../src/server/assets";
import assert from "node:assert/strict";
import { fixture } from "../tests/fixtures";
import {
	capturedMailSchema,
	expectedSourceMail,
	restoreSourceOutbound,
	sourceOutboundCapture,
	verifySourceObjects,
} from "../tests/source-outbound-fixture";
import {
	startFixtureSetupProvider,
	writeSetupFixturePreload,
} from "../tests/setup-provider";

const state = await fixture(),
	provider = await startFixtureSetupProvider(state.directory);
if (process.argv.includes("--global-key"))
	provider.cf.access.auth = {
		kind: "global-key",
		key: "queued-global-key",
		email: "owner@example.com",
	};
const legacyDirectory = join(state.directory, "original-schema");
await mkdir(legacyDirectory);
const sourceDb = new Database(join(legacyDirectory, "mailflare.sqlite"));
sourceDb.exec(
	"CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TEXT DEFAULT CURRENT_TIMESTAMP)",
);
for (const [name, file] of getMigrations()) {
	if (name.endsWith(".sql") && name.slice(0, 4) < "0062") {
		sourceDb.exec(await file.text());
		sourceDb.query("INSERT INTO d1_migrations(name) VALUES(?)").run(name);
	}
}
// The executable's first scheduled invocation must upgrade this legacy schema
// before it reads jobs; importing into an already current DB alone misses that.
process.env.DATA_DIR = legacyDirectory;
const preload = await writeSetupFixturePreload(state.directory, provider.url);
const binary = resolve(process.argv[2] ?? "dist/mailrun-local");
const deliveries: ReturnType<typeof capturedMailSchema.parse>[] = [];
const originalFetch = provider.cf.fetch;
provider.cf.fetch = async (input, init) => {
	const request = new Request(input, init),
		url = new URL(request.url);
	if (
		url.pathname ===
			`/client/v4/accounts/${provider.cf.access.accountId}/email/sending/send` &&
		request.method === "POST"
	) {
		deliveries.push(capturedMailSchema.parse(await request.json()));
		return Response.json({
			success: true,
			result: {
				message_id: `<source-delivery-${deliveries.length}@example.com>`,
			},
		});
	}
	return originalFetch(input, init);
};
const env = {
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	TMPDIR: process.env.TMPDIR,
	DATA_DIR: legacyDirectory,
	APP_URL: provider.publicOrigin,
	...(provider.cf.access.auth.kind === "token"
		? { CF_TOKEN: provider.cf.access.auth.token }
		: {
				CF_API_KEY: provider.cf.access.auth.key,
				CF_EMAIL: provider.cf.access.auth.email,
			}),
	CF_ACCOUNT_ID: provider.cf.access.accountId ?? undefined,
	NODE_EXTRA_CA_CERTS: provider.cert,
	BUN_OPTIONS: "--preload " + preload.path,
};
async function cron() {
	const child = Bun.spawn([binary, "jobs", "scheduled"], {
		env,
		cwd: state.directory,
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
	try {
		const [status, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (status !== 0 || stderr.trim())
			throw new Error(`Compiled scheduled task failed (${status}): ${stderr}`);
		const outcome = JSON.parse(stdout) as unknown;
		assert.ok(
			outcome &&
				typeof outcome === "object" &&
				"job" in outcome &&
				outcome.job === "scheduled",
			"Cron did not dispatch the scheduled task",
		);
	} finally {
		clearTimeout(timer);
	}
}
try {
	await restoreSourceOutbound(sourceDb);
	const payloads = sourceDb
		.query("SELECT id,payload FROM outbound_jobs ORDER BY id")
		.all();
	await cron();
	assert.deepEqual(
		sourceDb
			.query(
				"SELECT name FROM d1_migrations WHERE name IN ('0068_domain_relay_binding.sql','0069_cloudflare_global_key.sql') ORDER BY name",
			)
			.all(),
		[{ name: "0068_domain_relay_binding.sql" }, { name: "0069_cloudflare_global_key.sql" }],
		"Compiled startup did not upgrade the source schema",
	);
	assert.equal(deliveries.length, 0, "An imported future job sent early");
	assert.deepEqual(
		sourceDb.query("SELECT status FROM outbound_jobs").all(),
		Array(3).fill({ status: "queued" }),
	);
	assert.deepEqual(
		sourceDb.query("SELECT id,payload FROM outbound_jobs ORDER BY id").all(),
		payloads,
	);
	sourceDb.exec("UPDATE outbound_jobs SET scheduled_at=0");
	await Promise.all([cron(), cron()]);
	assert.deepEqual(
		deliveries,
		expectedSourceMail,
		"Native delivery changed a source queue payload",
	);
	assert.deepEqual(
		sourceDb.query("SELECT status FROM outbound_jobs").all(),
		Array(3).fill({ status: "sent" }),
	);
	assert.deepEqual(
		sourceDb
			.query(
				"SELECT actor_user_id,mailbox_id,message_id,action,metadata FROM audit_logs WHERE action='email.send' ORDER BY rowid",
			)
			.all(),
		sourceOutboundCapture.expected.audits,
	);
	await cron();
	assert.equal(
		deliveries.length,
		3,
		"Cron replay duplicated provider delivery",
	);
	assert.deepEqual(
		sourceDb.query("SELECT id,payload FROM outbound_jobs ORDER BY id").all(),
		payloads,
	);
	assert.deepEqual(sourceDb.query("PRAGMA foreign_key_check").all(), []);
	await verifySourceObjects();
	console.log(
		JSON.stringify(
			{
				source: sourceOutboundCapture.provenance,
				originalFullBackup: "passed",
				legacySchemaStartupUpgrade: "passed",
				futureSchedule: "passed",
				compiledCronDelivery: "passed",
				headersAndThreading: "passed",
				inlineAttachmentBytes: "passed",
				sendAudit: "passed",
				concurrentCronAndReplay: "passed",
				preservedPayloadsAndObjects: "passed",
				providerCalls: deliveries.length,
				externalRequests: 0,
			},
			null,
			2,
		),
	);
} finally {
	sourceDb.close();
	await provider.stop();
	await state.close();
}
