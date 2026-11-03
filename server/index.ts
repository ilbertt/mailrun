import { migrate } from "../src/server/db";
import { cronJobFromArgs } from "../src/server/jobs/cron";
import { configureRegexEntrypoint } from "../src/server/mail/regex-execution";

process.umask(0o077);
configureRegexEntrypoint(import.meta.path);
if (process.argv[2] === "regex-match") {
	const { runRegexProcess } = await import(
		"../src/server/mail/regex-execution"
	);
	await runRegexProcess();
} else if (process.argv[2] === "migrate-source") {
	const { runSourceMigration } = await import("../src/server/migration/cli");
	await runSourceMigration(process.argv.slice(3));
} else {
	await migrate();
	const name = cronJobFromArgs(process.argv);
	if (name) {
		const { runJob } = await import("../src/server/jobs/runner");
		console.log(JSON.stringify({ job: name, ...(await runJob(name)) }));
	} else {
		// CLI jobs never initialize HTTP-only SDKs or request handlers.
		const { startHttpServer } = await import("./http");
		await startHttpServer(import.meta.path);
	}
}
