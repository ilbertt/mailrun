import { Database } from "bun:sqlite";
import { resolve, join, basename } from "node:path";
import { z } from "zod";
import {
	ruleSamples,
	prepareRuleFixture,
	ruleRequest,
	ruleSnapshot,
} from "../tests/rule-contract-fixture";
const source = resolve(process.argv[2] ?? ""),
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
const db = new Database(join(root, "original/mailflare.sqlite"));
db.exec("PRAGMA busy_timeout=5000");
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
	] as const) {
		const r = await fetch(base + "/api/auth/login", {
			method: "POST",
			headers: { Origin: base, "Content-Type": "application/json" },
			body: JSON.stringify({ email, password: "session-fixture-password" }),
		});
		if (!r.ok) throw new Error("Synthetic login failed");
		tokens[actor] = z.object({ token: z.string() }).parse(await r.json()).token;
	}
	const cases = [];
	for (const sample of ruleSamples) {
		prepareRuleFixture(db, sample);
		const started = Math.floor(Date.now() / 1000);
		const response = await fetch(
			ruleRequest(sample, base, {
				Authorization: "Bearer " + tokens[sample.actor ?? "owner"],
			}),
			{ signal: AbortSignal.timeout(30000) },
		);
		cases.push({
			name: sample.name,
			snapshot: await ruleSnapshot(db, response, started),
		});
	}
	const sourceHashes: Record<string, string> = {};
	for (const file of [
		"src/app/api/routing-rules/route.ts",
		"src/app/api/routing-rules/[id]/route.ts",
		"src/app/api/routing-rules/domain/route.ts",
		"src/app/api/routing-rules/domain/[id]/route.ts",
		"src/lib/domains/routing-rules.ts",
		"src/lib/mailboxes/access.ts",
		"src/lib/validators.ts",
	])
		sourceHashes[file] = new Bun.CryptoHasher("sha256")
			.update(await Bun.file(join(source, file)).bytes())
			.digest("hex");
	await Bun.write(
		"tests/source-rule-contracts.json",
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
	console.log(JSON.stringify({ originalRuleContracts: cases.length }));
} finally {
	db.close();
}
