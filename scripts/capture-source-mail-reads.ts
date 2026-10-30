// Run only against the pinned original server and disposable synthetic users.
import { Database } from "bun:sqlite";
import { resolve, join, basename } from "node:path";
import { z } from "zod";
import {
	readSamples,
	readApiKey,
	readPath,
	prepareReadFixture,
	normalizeReadBody,
} from "../tests/mail-read-fixture";
const reference = resolve(process.argv[2] ?? ""),
	root = resolve(process.argv[3] ?? ""),
	base = process.argv[4];
if (
	!base ||
	!basename(root).startsWith("mailrun-test-") ||
	!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)
)
	throw new Error(
		"Usage: bun scripts/capture-source-mail-reads.ts <71aa49b-reference> <session-fixture-directory> <original-loopback-origin>",
	);
const db = new Database(join(root, "original/mailflare.sqlite"));
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
		const res = await fetch(base + "/api/auth/login", {
			method: "POST",
			headers: { Origin: base, "Content-Type": "application/json" },
			body: JSON.stringify({ email, password: "session-fixture-password" }),
		});
		if (!res.ok) throw new Error("Synthetic source login failed");
		tokens[actor] = z
			.object({ token: z.string() })
			.parse(await res.json()).token;
	}
	const cases = [];
	for (const sample of readSamples) {
		prepareReadFixture(db, sample);
		const res = await fetch(base + readPath(sample), {
			headers: {
				Authorization:
					"Bearer " +
					(sample.kind === "v1" ? readApiKey : tokens[sample.actor ?? "owner"]),
				...(sample.headerZone ? { "X-Time-Zone": sample.headerZone } : {}),
			},
		});
		if (!res.headers.get("Content-Type")?.includes("application/json"))
			throw new Error(
				`Unexpected source response for ${sample.name}: HTTP ${res.status}`,
			);
		cases.push({
			name: sample.name,
			status: res.status,
			body: normalizeReadBody(await res.json()),
		});
	}
	const sourceHashes: Record<string, string> = {};
	for (const file of [
		"src/app/api/messages/route.ts",
		"src/app/api/v1/messages/route.ts",
		"src/app/api/messages/utils.ts",
		"src/app/api/messages/counts/route.ts",
		"src/app/api/messages/counts/utils.ts",
		"src/app/api/messages/navigation/route.ts",
		"src/lib/mailboxes/access.ts",
		"src/lib/contacts/service.ts",
		"src/lib/profile/identity-utils.ts",
		"src/lib/search/conditions.ts",
		"src/lib/time/utils.ts",
	])
		sourceHashes[file] = new Bun.CryptoHasher("sha256")
			.update(await Bun.file(join(reference, file)).text())
			.digest("hex");
	await Bun.write(
		"tests/source-mail-reads.json",
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
	console.log(`Captured ${cases.length} original mailbox read contracts.`);
} finally {
	db.close();
}
