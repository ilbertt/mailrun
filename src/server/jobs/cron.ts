import { jobNameSchema } from "./runner";

export const cronJobs = [
	{ title: "mailrun-scheduled", schedule: "* * * * *", command: "scheduled" },
	{ title: "mailrun-maintenance", schedule: "*/5 * * * *", command: "maintenance" },
	{ title: "mailrun-backup", schedule: "0 2 * * *", command: "backup" },
] as const;

export function cronJobFromArgs(args: string[]) {
	const registered = cronJobs.find(job => args.includes(`--cron-title=${job.title}`));
	if (registered) return registered.command;
	if (args[2] === "jobs") return jobNameSchema.parse(args[3]);
	if (args.some(argument => argument.startsWith("--cron-title="))) throw new Error("Unknown cron job");
	return null;
}
export async function registerCrons(entrypoint: string) {
	if (!process.env.NIBRUN_DATA_DIR) return;
	for (const job of cronJobs) await Bun.cron(entrypoint, job.schedule, job.title);
}
