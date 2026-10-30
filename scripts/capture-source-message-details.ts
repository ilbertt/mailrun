// Run only against the pinned original server and disposable synthetic users.
import { Database } from "bun:sqlite";
import { resolve, join, basename } from "node:path";
import { z } from "zod";
import {
	detailSamples,
	detailPath,
	prepareDetailFixture,
	detailSnapshot,
} from "../tests/message-detail-fixture";

const reference = resolve(process.argv[2] ?? ""),
	root = resolve(process.argv[3] ?? ""),
	base = process.argv[4];
if (
	!base ||
	!basename(root).startsWith("mailrun-test-") ||
	!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)
)
	throw new Error(
		"Usage: bun scripts/capture-source-message-details.ts <71aa49b-reference> <session-fixture-directory> <original-loopback-origin>",
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
	for (const sample of detailSamples) {
		await prepareDetailFixture(db, join(root, "original"), sample);
		const response = await fetch(base + detailPath(sample), {
			headers: { Authorization: "Bearer " + tokens[sample.actor ?? "owner"] },
			signal: AbortSignal.timeout(30000),
		});
		cases.push({ name: sample.name, ...(await detailSnapshot(response)) });
	}

	const sourceHashes: Record<string, string> = {};
	for (const file of [
		"src/app/api/messages/[messageId]/route.ts",
		"src/app/api/messages/[messageId]/metadata/route.ts",
		"src/app/api/messages/[messageId]/thread/route.ts",
		"src/app/api/messages/[messageId]/attachments/[attachmentId]/route.ts",
		"src/app/api/messages/[messageId]/attachments/[attachmentId]/utils.ts",
		"src/lib/email/inbound.ts",
		"src/lib/email/thread-view.ts",
		"src/lib/email/attachments.ts",
		"src/lib/email/unsubscribe.ts",
		"src/lib/contacts/service.ts",
		"src/lib/mailboxes/access.ts",
		"src/lib/http/content-type.ts",
		"server/runtime/file-bucket.ts",
	])
		sourceHashes[file] = new Bun.CryptoHasher("sha256")
			.update(await Bun.file(join(reference, file)).text())
			.digest("hex");
	await Bun.write(
		"tests/source-message-details.json",
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
		`Captured ${cases.length} original message detail and attachment contracts.`,
	);
} finally {
	db.close();
}
