import { resolve } from "node:path";
import { deepStrictEqual } from "node:assert";
import { fixture } from "../tests/fixtures";
import {
	queueSamples,
	restoreQueuedBefore,
	applyQueuedChanges,
	queuedSnapshot,
	queueDeliveryTime,
	QUEUE_ORIGIN,
} from "../tests/queued-delivery-fixture";
import capture from "../tests/source-queued-delivery-contracts.json";
import { startSendProvider } from "../tests/send-provider";
import { z } from "zod";
const state = await fixture(),
	provider = await startSendProvider(state.directory),
	binary = resolve(process.argv[2] ?? "dist/mailrun-local");
state.db.exec("PRAGMA busy_timeout=5000");
const env = {
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	TMPDIR: process.env.TMPDIR,
	DATA_DIR: state.directory,
	APP_URL: QUEUE_ORIGIN,
	NODE_ENV: "production",
	NODE_EXTRA_CA_CERTS: provider.cert,
	BUN_OPTIONS: "--preload " + provider.preload,
};
async function cron(clock: number) {
	const child = Bun.spawn([binary, "jobs", "scheduled"], {
		cwd: state.directory,
		env: { ...env, MAILRUN_FIXTURE_CLOCK: String(clock) },
		stdout: "pipe",
		stderr: "pipe",
		timeout: 30000,
		killSignal: "SIGKILL",
	});
	const [out, err] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (await child.exited) throw new Error("Queued delivery CLI failed: " + err);
	z.object({ job: z.literal("scheduled") })
		.passthrough()
		.parse(JSON.parse(out));
	return err;
}
const snapshotData = (value: unknown) => {
	const {
		status: _status,
		body: _body,
		...data
	} = z.record(z.string(), z.unknown()).parse(value);
	return data;
};
try {
	let passed = 0;
	const failures: string[] = [];
	for (const sample of queueSamples) {
		const expected = capture.cases.find((row) => row.name === sample.name);
		if (!expected) throw new Error("Missing source queued case");
		const identity = await restoreQueuedBefore(
			state.db,
			state.directory,
			expected.before,
		);
		await applyQueuedChanges(state.db, state.directory, sample, identity);
		provider.reset(sample.failure);
		await cron(queueDeliveryTime(sample));
		try {
			deepStrictEqual(
				snapshotData(
					await queuedSnapshot(
						state.db,
						state.directory,
						Response.json({ ok: true }),
						provider.deliveries,
						identity,
					),
				),
				snapshotData(expected.snapshot),
				sample.name,
			);
			passed++;
		} catch (error) {
			failures.push(sample.name);
			if (process.env.MAILRUN_QUEUE_TRACE) console.error(error);
		}
	}
	if (failures.length)
		throw new Error(
			JSON.stringify({ passed, failed: failures.length, cases: failures }),
		);
	const ordinary = queueSamples[0]!,
		expected = capture.cases.find((row) => row.name === "ordinary")!;
	const identity = await restoreQueuedBefore(
		state.db,
		state.directory,
		expected.before,
	);
	provider.reset();
	await Promise.all([
		cron(queueDeliveryTime(ordinary)),
		cron(queueDeliveryTime(ordinary)),
	]);
	deepStrictEqual(provider.deliveries.length, 1);
	await cron(queueDeliveryTime(ordinary));
	deepStrictEqual(provider.deliveries.length, 1);
	deepStrictEqual(
		state.db
			.query("SELECT status FROM outbound_jobs WHERE id=?")
			.get(identity.jobId),
		{ status: "sent" },
	);
	console.log(
		JSON.stringify({
			originalQueuedDelivery: passed,
			independentCronClaims: true,
			restartReplay: true,
			externalDelivery: 0,
		}),
	);
} finally {
	provider.stop();
	await state.close();
}
