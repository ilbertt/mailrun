import { parseArgs } from "node:util";
import { z } from "zod";
import { migrateSourceBucket } from "./source-bucket";

export async function runSourceMigration(args: string[]) {
	const { values } = parseArgs({
		args,
		options: {
			help: { type: "boolean", short: "h" },
			backup: { type: "string" },
			bucket: { type: "string" },
			destination: { type: "string" },
		},
	});
	if (values.help) {
		console.log(
			"Usage: mailrun migrate-source --backup <full-records.json> --bucket <frozen-bucket-directory> --destination <new-data-directory>",
		);
		return;
	}
	const input = z
		.object({
			backup: z.string().min(1),
			bucket: z.string().min(1),
			destination: z.string().min(1),
		})
		.parse(values);
	console.log(JSON.stringify(await migrateSourceBucket(input)));
}
