import { performance } from "node:perf_hooks";
import { fixture, owner } from "../tests/fixtures";
import { listMessages, getThread } from "../src/server/mail/repository";
import { writeFile } from "node:fs/promises";

const state = await fixture();
try {
	const insert = state.db.query("INSERT INTO messages (id,user_id,mailbox_id,direction,from_addr,to_addr,subject,snippet,text_body,status,created_at) VALUES (?,'owner','mailbox','inbound','sender@example.org','hello@example.com',?,?,'Benchmark body searchable','received',?)");
	state.db.transaction(() => { for (let index = 0; index < 10000; index++) insert.run(`bench-${index}`, `Message ${index}`, "A small preview", 1_700_000_000 + index); })();
	const cases = {
		inbox: () => listMessages(owner, { folder: "inbox", q: "", offset: 0 }),
		search: () => listMessages(owner, { folder: "inbox", q: "searchable", offset: 0 }),
		deepPage: () => listMessages(owner, { folder: "inbox", q: "", offset: 5000 }),
		conversation: () => getThread(owner, "bench-5000"),
	};
	const results: Record<string, { p50Ms: number; p95Ms: number }> = {};
	for (const [name, run] of Object.entries(cases)) {
		for (let warmup = 0; warmup < 5; warmup++) await run();
		const times: number[] = [];
		for (let sample = 0; sample < 50; sample++) {
			const started = performance.now(); await run(); times.push(performance.now() - started);
		}
		times.sort((a, b) => a - b);
		results[name] = { p50Ms: Number((times[25] ?? 0).toFixed(2)), p95Ms: Number((times[47] ?? 0).toFixed(2)) };
	}
	const report = { measuredAt: new Date().toISOString(), bun: Bun.version, platform: `${process.platform}-${process.arch}`, messages: 10001, samples: 50, scope: "Local repository/database calls, includes authorization; excludes HTTP, browser rendering and nibrun cold start. Not a comparison with the old app.", results };
	console.log(JSON.stringify(report, null, 2));
	if (process.env.BENCHMARK_OUTPUT) await writeFile(process.env.BENCHMARK_OUTPUT, JSON.stringify(report, null, 2) + "\n");
} finally { await state.close(); }
