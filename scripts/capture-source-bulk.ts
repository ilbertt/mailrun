// Captures actual unmodified source HTTP behavior in disposable fixture data.
import { Database } from "bun:sqlite";
import { resolve, join, basename } from "node:path";
import { z } from "zod";
import {
	bulkSamples,
	bulkPath,
	bulkPayload,
	prepareBulkFixture,
	bulkSnapshot,
} from "../tests/bulk-contract-fixture";

const reference = resolve(process.argv[2] ?? ""),
	root = resolve(process.argv[3] ?? ""),
	base = process.argv[4];
if (
	!base ||
	!basename(root).startsWith("mailrun-test-") ||
	!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)
)
	throw new Error(
		"Usage: bun scripts/capture-source-bulk.ts <71aa49b-reference> <session-fixture-directory> <original-loopback-origin>",
	);
const directory = join(root, "original"),
	db = new Database(join(directory, "mailflare.sqlite"));
try {
	if (
		(
			db.query("SELECT email FROM users WHERE id='owner'").get() as {
				email: string;
			} | null
		)?.email !== "hello@example.com"
	)
		throw new Error("Not the disposable session fixture");
	const tokens: Record<string, string> = {};
	for (const [actor, email] of [
		["owner", "hello@example.com"],
		["stranger", "stranger@example.com"],
	] as const) {
		const response = await fetch(base + "/api/auth/login", {
			method: "POST",
			headers: { Origin: base, "Content-Type": "application/json" },
			body: JSON.stringify({ email, password: "session-fixture-password" }),
		});
		if (!response.ok) throw new Error("Synthetic source login failed");
		tokens[actor] = z
			.object({ token: z.string() })
			.parse(await response.json()).token;
	}
	const cases = [];
	for (const sample of bulkSamples) {
		await prepareBulkFixture(db, directory, sample);
		const started = Math.floor(Date.now() / 1000),
			body = sample.rawBody ?? JSON.stringify(bulkPayload(sample));
		const response = await fetch(base + bulkPath(sample), {
			method: sample.method ?? "POST",
			headers: {
				Origin: base,
				Authorization: "Bearer " + tokens[sample.actor],
				"Content-Type": "application/json",
			},
			...(sample.method === "GET" ? {} : { body }),
		});
		if (!response.headers.get("Content-Type")?.includes("application/json"))
			throw new Error(
				`Unexpected source response for ${sample.name}: HTTP ${response.status}`,
			);
		cases.push({
			name: sample.name,
			requestSha256: body
				? new Bun.CryptoHasher("sha256").update(body).digest("hex")
				: null,
			status: response.status,
			...(await bulkSnapshot(
				db,
				directory,
				sample,
				await response.json(),
				started,
			)),
		});
	}
	const sourceHashes: Record<string, string> = {};
	for (const file of [
		"src/app/api/messages/bulk/route.ts",
		"src/app/api/messages/bulk/utils.ts",
		"src/app/api/messages/empty/route.ts",
		"src/app/api/messages/empty/utils.ts",
		"src/app/api/folders/route.ts",
		"src/app/api/folders/utils.ts",
		"src/lib/email/permanent-delete.ts",
		"src/lib/email/message-cleanup.ts",
		"src/lib/spam/feedback.ts",
		"server/runtime/env.ts",
		"server/runtime/file-bucket.ts",
	])
		sourceHashes[file] = new Bun.CryptoHasher("sha256")
			.update(await Bun.file(join(reference, file)).text())
			.digest("hex");
	await Bun.write(
		"tests/source-bulk-contracts.json",
		JSON.stringify(
			{
				sourceRevision: "71aa49b",
				sourceVersion: "0.5.2",
				sourceHashes,
				cases,
			},
			null,
			2,
		) + "\n",
	);
	console.log(
		`Captured ${cases.length} original bulk, empty-folder and folder contracts.`,
	);
} finally {
	db.close();
}
