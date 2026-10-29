import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { z } from "zod";
import {
	navigationMetricsSchema,
	navigationBenchmarkMetadataSchema,
} from "./navigation-benchmark-schema";

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		input: { type: "string" },
		output: { type: "string" },
		warmup: { type: "string" },
		samples: { type: "string" },
	},
});
const args = z
	.object({
		input: z.string(),
		output: z.string().optional(),
		warmup: z.coerce.number().int().nonnegative().default(11),
		samples: z.coerce.number().int().min(2).default(20),
	})
	.parse(values);
const directory = resolve(args.input);
const metadata = navigationBenchmarkMetadataSchema.parse(
	await Bun.file(join(directory, "metadata.json")).json(),
);
const results = [];
for (const name of ["original", "before", "after"] as const) {
	const metrics = navigationMetricsSchema.parse(
		await Bun.file(join(directory, name + "-browser-metrics.json")).json(),
	);
	const ids = metrics.events
		.filter((event) => event.kind === "start")
		.map((event) => event.id);
	if (new Set(ids).size !== ids.length)
		throw new Error(
			"Repeated sequence IDs: do not reload during a measured run",
		);
	const completed = metrics.events.filter((event) => event.kind === "done");
	if (completed.length !== ids.length)
		throw new Error("Incomplete browser measurements for " + name);
	const startedPaths = new Map(
		metrics.events
			.filter((event) => event.kind === "start")
			.map((event) => [event.id, event.path]),
	);
	if (
		new Set(completed.map((event) => event.id)).size !== completed.length ||
		completed.some((event) => startedPaths.get(event.id) !== event.path)
	)
		throw new Error("Unmatched browser measurements for " + name);
	const measured = completed.slice(args.warmup, args.warmup + args.samples);
	if (measured.length !== args.samples)
		throw new Error("Not enough completed navigations for " + name);
	const times = measured.map((event) => event.elapsedMs).sort((a, b) => a - b);
	const first = measured[0]!.id,
		last = measured.at(-1)!.id;
	const requests = metrics.requests.filter(
		(request) => request.nav >= first && request.nav <= last,
	);
	const functions = requests.filter((request) =>
		request.path.startsWith("/_serverFn/"),
	);
	const middle = Math.floor(times.length / 2);
	const median =
		times.length % 2
			? times[middle]!
			: (times[middle - 1]! + times[middle]!) / 2;
	results.push({
		name,
		samples: times.length,
		medianMs: Number(median.toFixed(2)),
		p95Ms: Number(times[Math.ceil(times.length * 0.95) - 1]!.toFixed(2)),
		timingsMs: times.map((value) => Number(value.toFixed(2))),
		serverFunctionRequests: functions.length,
		serverFunctionBodyBytes: functions.reduce(
			(total, request) => total + request.bytes,
			0,
		),
		initialDocumentBytes: metrics.requests.find(
			(request) => request.nav === 0 && request.path === "/inbox",
		)?.bytes,
		failedRequests: requests.filter((request) => request.status >= 400).length,
	});
}
const report = {
	...metadata,
	warmupNavigations: args.warmup,
	scope:
		"Production builds, cloned synthetic SQLite data, English Inbox/Sent navigation in a real browser. Click to matching heading/first visible message plus two animation frames. No bandwidth throttling, nibrun guest or cold-start measurement. Body counts are uncompressed proxy payloads. Median averages the two middle samples; p95 uses nearest rank.",
	results,
};
const text = JSON.stringify(report, null, 2) + "\n";
if (args.output) await Bun.write(resolve(args.output), text);
console.log(text);
