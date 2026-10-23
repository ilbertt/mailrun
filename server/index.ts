import { migrate } from "../src/server/db";
import { runJob } from "../src/server/jobs/runner";
import { registerCrons, cronJobFromArgs } from "../src/server/jobs/cron";
import { getAssetRoutes } from "../src/server/assets";

process.umask(0o077);
await migrate();
const name = cronJobFromArgs(process.argv);
if (name) {
	console.log(JSON.stringify({ job: name, ...(await runJob(name)) }));
} else {
	// Literal imports are bundled into the executable, including Start's lazy chunks.
	const { default: handler } = await import("#start-handler");
	await registerCrons(import.meta.path);
	const server = Bun.serve({
		port: Number(process.env.PORT ?? 3000),
		hostname: process.env.HOST ?? "0.0.0.0",
		idleTimeout: 60,
		maxRequestBodySize: 30 * 1024 * 1024,
		routes: getAssetRoutes(),
		async fetch(request) {
			return handler.fetch(request);
		},
	});
	console.log(`Mailrun listening on ${server.url}`);
	const shutdown = async () => {
		await server.stop(false);
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}
