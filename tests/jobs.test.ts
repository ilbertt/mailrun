import { test, expect } from "bun:test";
import { fixture } from "./fixtures";
import { cronJobs, cronJobFromArgs } from "../src/server/jobs/cron";
import { runJob } from "../src/server/jobs/runner";
import { seconds } from "../src/server/db";

test("cron dispatches Bun's registered job arguments before starting HTTP", () => {
	expect(cronJobs).toHaveLength(3);
	expect(cronJobFromArgs(["/mnt/artifact/server", "run", "--cron-title=mailrun-scheduled", "--cron-period=* * * * *"])).toBe("scheduled");
	expect(cronJobFromArgs(["bun", "server/index.ts", "jobs", "maintenance"])).toBe("maintenance");
	expect(cronJobFromArgs(["bun", "server/index.ts"])).toBeNull();
	expect(() => cronJobFromArgs(["--cron-title=unknown"])).toThrow("Unknown cron job");
});
test("a live lease excludes overlapping execution and expired leases are recovered", async () => {
	const state = await fixture();
	try {
		state.db.query("INSERT INTO mailrun_job_leases VALUES ('maintenance','other',?)").run(seconds() + 60);
		expect(await runJob("maintenance")).toEqual({ skipped: true });
		state.db.query("UPDATE mailrun_job_leases SET expires_at=0").run();
		expect(await runJob("maintenance")).toEqual({ skipped: false });
		expect(state.db.query("SELECT * FROM mailrun_job_leases").all()).toEqual([]);
	} finally { await state.close(); }
});
test("scheduled backups honor settings and do not repeat a completed daily backup", async () => {
	const state = await fixture();
	try {
		await runJob("backup");
		expect(state.db.query("SELECT id FROM backups").all()).toHaveLength(0);
		state.db.query("UPDATE backup_settings SET enabled=1").run();
		await runJob("backup");
		await runJob("backup");
		expect(state.db.query("SELECT status FROM backups").all()).toEqual([{ status: "completed" }]);
	} finally { await state.close(); }
});
