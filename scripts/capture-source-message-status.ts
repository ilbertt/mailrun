// Run against serve-session-fixture.ts only; the reference source is never edited.
import { resolve, join, basename } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";

const reference = resolve(process.argv[2] ?? ""),
	fixture = resolve(process.argv[3] ?? ""),
	base = process.argv[4];
if (
	!base ||
	!basename(fixture).startsWith("mailrun-test-") ||
	!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)
)
	throw new Error(
		"Usage: bun scripts/capture-source-message-status.ts <71aa49b-reference> <session-fixture-directory> <original-loopback-origin>",
	);
const db = new Database(join(fixture, "original/mailflare.sqlite"));
try {
	const owner = db.query("SELECT email FROM users WHERE id='owner'").get() as {
		email?: string;
	} | null;
	if (owner?.email !== "hello@example.com")
		throw new Error("Not the disposable session fixture");
	const tokens: Record<string, string> = {};
	for (const [actor, email] of [
		["owner", "hello@example.com"],
		["stranger", "stranger@example.com"],
	]) {
		const response = await fetch(base + "/api/auth/login", {
			method: "POST",
			headers: { Origin: base, "Content-Type": "application/json" },
			body: JSON.stringify({ email, password: "session-fixture-password" }),
		});
		if (!response.ok) throw new Error("Synthetic source login failed");
		tokens[actor!] = z
			.object({ token: z.string() })
			.parse(await response.json()).token;
	}
	const cases: {
		name: string;
		actor: string;
		initialStatus: string;
		status: string;
		permission?: string;
		direction?: string;
		messageId?: string;
	}[] = [
		...["received", "sent", "draft", "trash", "spam"].map((status) => ({
			name: `owner-${status}`,
			actor: "owner",
			initialStatus: "received",
			status,
		})),
		{
			name: "owner-spam-to-received",
			actor: "owner",
			initialStatus: "spam",
			status: "received",
		},
		{
			name: "invalid-archived",
			actor: "owner",
			initialStatus: "received",
			status: "archived",
		},
		{
			name: "missing-message",
			actor: "owner",
			initialStatus: "received",
			status: "trash",
			messageId: "missing",
		},
		{
			name: "unshared",
			actor: "stranger",
			initialStatus: "received",
			status: "trash",
		},
		{
			name: "read-only",
			actor: "stranger",
			initialStatus: "received",
			status: "trash",
			permission: "read_only",
		},
		{
			name: "full-access",
			actor: "stranger",
			initialStatus: "received",
			status: "trash",
			permission: "full_access",
		},
		{
			name: "outbound-spam",
			actor: "owner",
			initialStatus: "sent",
			status: "spam",
			direction: "outbound",
		},
	];
	const captured = [];
	for (const sample of cases) {
		db.exec(
			"DELETE FROM spam_feedback; DELETE FROM spam_token_stats; DELETE FROM spam_reputation; DELETE FROM audit_logs; DELETE FROM mailbox_access; UPDATE mailboxes SET type='shared',disabled=0 WHERE id='mailbox'; INSERT INTO license_settings(id,instance_id,plan,state,updated_at) VALUES('default','fixture','team','active',1) ON CONFLICT(id) DO UPDATE SET plan='team',state='active'; INSERT OR IGNORE INTO folders(id,user_id,mailbox_id,name,created_at) VALUES('status-folder','owner','mailbox','Status folder',1)",
		);
		db.query(
			"UPDATE messages SET status=?,direction=?,folder_id='status-folder',snoozed_until=4000000000,trashed_at=123,starred=1,read=0 WHERE id='message'",
		).run(sample.initialStatus, sample.direction ?? "inbound");
		db.exec("UPDATE messages SET trashed_at=123 WHERE id='message'");
		if (sample.permission)
			db.query(
				"INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES('status-share','mailbox','stranger',?,1)",
			).run(sample.permission);
		const started = Math.floor(Date.now() / 1000);
		const response = await fetch(
			`${base}/api/messages/${sample.messageId ?? "message"}/status`,
			{
				method: "POST",
				headers: {
					Origin: base,
					Authorization: "Bearer " + tokens[sample.actor],
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ status: sample.status }),
			},
		);
		const saved = db
			.query(
				"SELECT status,direction,folder_id,snoozed_until,trashed_at,starred,read FROM messages WHERE id='message'",
			)
			.get() as Record<string, unknown>;
		if (
			typeof saved.trashed_at === "number" &&
			saved.trashed_at >= started &&
			saved.trashed_at <= Math.floor(Date.now() / 1000)
		)
			saved.trashed_at = "now";
		captured.push({
			...sample,
			response: { status: response.status, body: await response.json() },
			message: saved,
			feedback: db
				.query(
					"SELECT classification FROM spam_feedback WHERE message_id='message'",
				)
				.get(),
			audit: db
				.query(
					"SELECT action,metadata FROM audit_logs ORDER BY created_at,rowid",
				)
				.all()
				.map((row) => {
					const value = row as { action: string; metadata: string | null };
					return {
						action: value.action,
						metadata: value.metadata
							? (JSON.parse(value.metadata) as unknown)
							: null,
					};
				}),
		});
	}
	const files = [
		"src/app/api/messages/[messageId]/status/route.ts",
		"src/app/api/messages/[messageId]/status/utils.ts",
		"src/lib/user.ts",
		"src/lib/spam/feedback.ts",
	];
	const hashes: Record<string, string> = {};
	for (const file of files)
		hashes[file] = new Bun.CryptoHasher("sha256")
			.update(await Bun.file(join(reference, file)).text())
			.digest("hex");
	await Bun.write(
		"tests/source-message-status.json",
		JSON.stringify(
			{
				sourceRevision: "71aa49b",
				sourceVersion: "0.5.2",
				sourceHashes: hashes,
				cases: captured,
			},
			null,
			2,
		) + "\n",
	);
	console.log(
		`Captured ${captured.length} original message-status responses and persisted effects.`,
	);
} finally {
	db.close();
}
