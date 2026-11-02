import { Database } from "bun:sqlite";
import { resolve, join, basename } from "node:path";
import { z } from "zod";
import {
	draftSamples,
	prepareDraftFixture,
	draftRequest,
	draftSnapshot,
} from "../tests/draft-contract-fixture";
const reference = resolve(process.argv[2] ?? ""),
	root = resolve(process.argv[3] ?? ""),
	base = process.argv[4];
if (
	!base ||
	!/^http:\/\/127\.0\.0\.1:\d+$/.test(base) ||
	!basename(root).startsWith("mailrun-test-")
)
	throw new Error(
		"Use a disposable session fixture and original loopback origin",
	);
const directory = join(root, "original"),
	db = new Database(join(directory, "mailflare.sqlite"));
try {
	if (
		(
			db.query("SELECT email FROM users WHERE id='owner'").get() as {
				email: string;
			}
		).email !== "hello@example.com"
	)
		throw new Error("Not the synthetic fixture");
	const tokens: Record<string, string> = {};
	for (const [actor, email] of [
		["owner", "hello@example.com"],
		["stranger", "stranger@example.com"],
	]) {
		const res = await fetch(base + "/api/auth/login", {
			method: "POST",
			headers: { Origin: base, "Content-Type": "application/json" },
			body: JSON.stringify({ email, password: "session-fixture-password" }),
		});
		if (!res.ok) throw new Error("Synthetic login failed");
		tokens[actor!] = z
			.object({ token: z.string() })
			.parse(await res.json()).token;
	}
	const cases = [];
	for (const sample of draftSamples) {
		await prepareDraftFixture(db, directory, sample);
		const started = Math.floor(Date.now() / 1000);
		const response = await fetch(
			draftRequest(sample, base, {
				Authorization: "Bearer " + tokens[sample.actor ?? "owner"],
			}),
			{ signal: AbortSignal.timeout(30000) },
		);
		cases.push({
			name: sample.name,
			snapshot: await draftSnapshot(db, directory, response, started),
		});
	}
	const sourceHashes: Record<string, string> = {};
	for (const file of [
		"src/app/api/drafts/route.ts",
		"src/app/api/drafts/utils.ts",
		"src/app/api/drafts/[id]/route.ts",
		"src/app/api/drafts/[id]/utils.ts",
		"src/app/api/drafts/[id]/attachments/route.ts",
		"src/app/api/drafts/[id]/attachments/[attachmentId]/route.ts",
		"src/lib/email/attachments.ts",
		"src/lib/email/message-cleanup.ts",
		"src/lib/email/sender.ts",
		"src/lib/email/parse.ts",
		"src/lib/agent/schedule.ts",
		"server/runtime/file-bucket.ts",
	])
		sourceHashes[file] = new Bun.CryptoHasher("sha256")
			.update(await Bun.file(join(reference, file)).bytes())
			.digest("hex");
	await Bun.write(
		"tests/source-draft-contracts.json",
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
	console.log(JSON.stringify({ originalDraftContracts: cases.length }));
} finally {
	db.close();
}
