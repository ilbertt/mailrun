import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { deepStrictEqual } from "node:assert";
import { fixture, owner } from "../tests/fixtures";
import {
	jmapSubmissionSamples,
	prepareJmapSubmission,
	jmapSubmissionRequest,
	jmapSubmissionSnapshot,
	JMAP_SUBMISSION_ORIGIN,
} from "../tests/jmap-submission-fixture";
import capture from "../tests/source-jmap-submission-contracts.json";
import { startSendProvider } from "../tests/send-provider";
import { queueSourceSend } from "../src/server/mail/session-send";
import { LocalStorage } from "../src/server/storage";
const state = await fixture(),
	binary = resolve(process.argv[2] ?? "dist/mailrun-local"),
	origin = "https://jmap-submit-fixture.example",
	provider = await startSendProvider(state.directory);
state.db.exec("PRAGMA busy_timeout=5000");
const environment = {
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	TMPDIR: process.env.TMPDIR,
	DATA_DIR: state.directory,
	HOST: "127.0.0.1",
	PORT: "0",
	APP_URL: origin,
	NODE_ENV: "production",
	NODE_EXTRA_CA_CERTS: provider.cert,
	BUN_OPTIONS: "--preload " + provider.preload,
};
let child: ReturnType<typeof Bun.spawn> | undefined,
	errors: Promise<string> | undefined,
	base = "";
async function start() {
	child = Bun.spawn([binary], {
		cwd: state.directory,
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (
		!child.stdout ||
		typeof child.stdout === "number" ||
		!child.stderr ||
		typeof child.stderr === "number"
	)
		throw new Error("No fixture streams");
	errors = new Response(child.stderr).text();
	const reader = child.stdout.getReader();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			(async () => {
				let text = "";
				base = "";
				while (!base) {
					const part = await reader.read();
					if (part.done) throw new Error("Send fixture exited");
					text += new TextDecoder().decode(part.value);
					base = text.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? "";
				}
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Send fixture did not boot")),
					15000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
}
async function stop() {
	if (child) {
		child.kill("SIGTERM");
		await child.exited;
		child = undefined;
	}
	const log = await errors;
	if (log) console.error(log);
	errors = undefined;
}
async function cron() {
	const command = Bun.spawn([binary, "jobs", "scheduled"], {
		cwd: state.directory,
		env: {
			...environment,
			MAILRUN_FIXTURE_CLOCK: String(Date.parse("2099-01-01T00:00:01Z")),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([
		new Response(command.stdout).text(),
		new Response(command.stderr).text(),
	]);
	if (await command.exited) throw new Error("Scheduled fixture failed: " + err);
	return out;
}
try {
	await start();
	if (!existsSync(provider.marker))
		throw new Error("JMAP network isolation did not load");
	let passed = 0;
	const failures: string[] = [];
	for (const sample of jmapSubmissionSamples) {
		const expected = capture.cases.find((row) => row.name === sample.name);
		if (!expected) throw new Error("Missing original JMAP submission case");
		await prepareJmapSubmission(state.db, state.directory, sample);
		provider.reset(
			!!(sample.failure || sample.failFirst),
			sample.failFirst ? 1 : Infinity,
		);
		if (sample.variant === "cleanup-failure")
			provider.beforeReply(async () => {
				await chmod(state.directory + "/blobs", 0o500);
			});
		const started = Math.floor(Date.now() / 1000);
		try {
			const response = await fetch(jmapSubmissionRequest(sample, base), {
				signal: AbortSignal.timeout(30000),
			});
			deepStrictEqual(
				await jmapSubmissionSnapshot(
					state.db,
					state.directory,
					response,
					started,
					provider.deliveries,
				),
				expected.snapshot,
				sample.name,
			);
			passed++;
		} catch (error) {
			failures.push(sample.name);
			if (process.env.MAILRUN_JMAP_SUBMIT_TRACE) console.error(error);
		} finally {
			await chmod(state.directory + "/blobs", 0o700);
		}
	}
	if (failures.length)
		throw new Error(
			JSON.stringify({ passed, failed: failures.length, cases: failures }),
		);
	await stop();
	async function publish() {
		await prepareJmapSubmission(state.db, state.directory, {
			name: "restarted-submission",
		});
		return queueSourceSend(
			owner,
			{
				mailboxId: "mailbox",
				from: "hello@example.com",
				to: "maya@example.net",
				subject: "JMAP persisted submission",
				text: "Approved body",
			},
			[
				{
					filename: "stored.txt",
					type: "text/plain",
					disposition: "inline",
					contentId: "source-cid",
					blob: new LocalStorage().file("stored.txt"),
				},
			],
			JMAP_SUBMISSION_ORIGIN,
			undefined,
			undefined,
			async (sql, publication) => {
				await sql.ReserveSourceJmapDraft`INSERT INTO mailrun_submission_drafts(job_id,draft_id,draft_revision) VALUES(${publication.jobId},${"draft"},${0})`;
			},
		);
	}
	const queued = await publish();
	const before = state.db
		.query("SELECT payload FROM outbound_jobs WHERE id=?")
		.get(queued.jobId);
	state.db.exec("DELETE FROM api_keys");
	provider.reset();
	await cron();
	deepStrictEqual(provider.deliveries.length, 1);
	deepStrictEqual(
		state.db
			.query("SELECT status FROM outbound_jobs WHERE id=?")
			.get(queued.jobId),
		{ status: "sent" },
	);
	deepStrictEqual(
		state.db
			.query("SELECT payload FROM outbound_jobs WHERE id=?")
			.get(queued.jobId),
		before,
	);
	deepStrictEqual(
		state.db.query("SELECT id FROM messages WHERE id='draft'").get(),
		null,
	);
	deepStrictEqual(
		state.db.query("SELECT * FROM mailrun_submission_drafts").all(),
		[],
	);
	deepStrictEqual(await new LocalStorage().file("stored.txt").exists(), false);
	await cron();
	deepStrictEqual(provider.deliveries.length, 1);
	const acknowledged = await publish();
	state.db
		.query("UPDATE outbound_jobs SET status='sent' WHERE id=?")
		.run(acknowledged.jobId);
	state.db
		.query(
			"UPDATE messages SET status='sent',provider_message_id='<ack@example.net>' WHERE id=?",
		)
		.run(acknowledged.messageId);
	state.db
		.query(
			"INSERT INTO audit_logs(id,actor_user_id,mailbox_id,message_id,action,created_at) VALUES('completed','owner','mailbox',?,'email.send',1)",
		)
		.run(acknowledged.messageId);
	provider.reset();
	await cron();
	await cron();
	deepStrictEqual(provider.deliveries.length, 0);
	deepStrictEqual(
		state.db.query("SELECT id FROM messages WHERE id='draft'").get(),
		null,
	);
	deepStrictEqual(
		state.db.query("SELECT * FROM mailrun_submission_drafts").all(),
		[],
	);
	console.log(
		JSON.stringify({
			originalJmapSubmissions: passed,
			queuedSubmissionAcrossRestart: true,
			approvedKeyRevocation: true,
			postAcknowledgementCleanupRecovery: true,
			restartReplay: true,
			externalDelivery: 0,
		}),
	);
} finally {
	await stop();
	provider.stop();
	await state.close();
}
