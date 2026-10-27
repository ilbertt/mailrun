import { exportMailbox } from "../src/server/mail-transfer/export";
import { queryMessages } from "../src/server/mail/message-query";
import { performance } from "node:perf_hooks";
import { fixture, owner } from "../tests/fixtures";
import { listMessages, getThread } from "../src/server/mail/repository";
import { writeFile } from "node:fs/promises";

const state = await fixture();
try {
	const insert = state.db.query(
		"INSERT INTO messages (id,user_id,mailbox_id,direction,from_addr,to_addr,subject,snippet,text_body,status,created_at) VALUES (?,'owner','mailbox','inbound','sender@example.org','hello@example.com',?,?,'Benchmark body searchable','received',?)",
	);
	state.db.transaction(() => {
		for (let index = 0; index < 10000; index++)
			insert.run(
				`bench-${index}`,
				`Message ${index}`,
				"A small preview",
				1_700_000_000 + index,
			);
	})();
	const cases = {
		inbox: () =>
			queryMessages(owner, {
				mailboxId: "mailbox",
				direction: "inbound",
				status: "received",
				group: "thread",
				limit: 25,
			}),
		search: () =>
			queryMessages(owner, {
				mailboxId: "mailbox",
				q: "searchable",
				limit: 25,
				group: "thread",
			}),
		deepPage: () =>
			queryMessages(owner, {
				mailboxId: "mailbox",
				direction: "inbound",
				status: "received",
				group: "thread",
				limit: 25,
				offset: 5000,
			}),
		conversation: () => getThread(owner, "bench-5000"),
	};
	const results: Record<string, { p50Ms: number; p95Ms: number }> = {};
	for (const [name, run] of Object.entries(cases)) {
		for (let warmup = 0; warmup < 5; warmup++) await run();
		const times: number[] = [];
		for (let sample = 0; sample < 50; sample++) {
			const started = performance.now();
			await run();
			times.push(performance.now() - started);
		}
		times.sort((a, b) => a - b);
		results[name] = {
			p50Ms: Number((times[25] ?? 0).toFixed(2)),
			p95Ms: Number((times[47] ?? 0).toFixed(2)),
		};
	}
	const exportStarted = performance.now();
	const exported = await exportMailbox(owner, "mailbox");
	let exportBytes = 0;
	for await (const chunk of exported.body!) exportBytes += chunk.length;
	const streamedExport = {
		samples: 1,
		elapsedMs: Number((performance.now() - exportStarted).toFixed(2)),
		bytes: exportBytes,
	};
	const report = {
		measuredAt: new Date().toISOString(),
		bun: Bun.version,
		platform: `${process.platform}-${process.arch}`,
		messages: 10001,
		samples: 50,
		scope:
			"Local repository/database calls, includes authorization; excludes HTTP, browser rendering and nibrun cold start. Not a comparison with the old app.",
		results,
		streamedExport,
	};
	console.log(JSON.stringify(report, null, 2));
	if (process.env.BENCHMARK_OUTPUT)
		await writeFile(
			process.env.BENCHMARK_OUTPUT,
			JSON.stringify(report, null, 2) + "\n",
		);
} finally {
	await state.close();
}
