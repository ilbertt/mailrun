// Disposable serve-session-fixture.ts data only; source handlers remain unmodified.
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
		"Usage: bun scripts/capture-source-message-actions.ts <71aa49b-reference> <session-fixture-directory> <original-loopback-origin>",
	);
const db = new Database(join(fixture, "original/mailflare.sqlite"));
type Sample = {
	name: string;
	actor: "owner" | "stranger";
	action: "read" | "star" | "snooze";
	method: "POST" | "DELETE";
	permission?: string;
	until?: unknown;
	status?: string;
	direction?: string;
	messageId?: string;
	read?: number;
	starred?: number;
	disabled?: number;
	team?: boolean;
	personal?: boolean;
};
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
	const future = "2099-01-01T12:00:00.987Z",
		cases: Sample[] = [];
	for (const role of [
		"owner",
		"unshared",
		"read_only",
		"send_on_behalf",
		"send_as",
		"full_access",
	]) {
		const actor = role === "owner" ? "owner" : "stranger";
		const permission =
			role === "owner" || role === "unshared" ? undefined : role;
		for (const action of ["read", "star", "snooze"] as const)
			cases.push({
				name: `${role}-${action}`,
				actor,
				permission,
				action,
				method: "POST",
				...(action === "snooze" ? { until: future } : {}),
			});
		cases.push({
			name: `${role}-unsnooze`,
			actor,
			permission,
			action: "snooze",
			method: "DELETE",
		});
	}
	for (const [name, until] of [
		["invalid", "bad date"],
		["empty", ""],
		["null", null],
		["number", 123],
		["past", "2000-01-01T00:00:00Z"],
		["offset", "2099-01-01T12:00:00+02:00"],
		["date-only", "2099-01-02"],
		["rfc-date", "Thu, 01 Jan 2099 12:00:00 GMT"],
	] as const)
		cases.push({
			name: `owner-snooze-${name}`,
			actor: "owner",
			action: "snooze",
			method: "POST",
			until,
		});
	cases.push(
		{
			name: "invalid-grant-read",
			actor: "stranger",
			permission: "unknown",
			action: "read",
			method: "POST",
		},
		{
			name: "invalid-grant-star",
			actor: "stranger",
			permission: "unknown",
			action: "star",
			method: "POST",
		},
		{
			name: "owner-read-again",
			actor: "owner",
			action: "read",
			method: "POST",
			read: 1,
		},
		{
			name: "owner-star-again",
			actor: "owner",
			action: "star",
			method: "POST",
			starred: 1,
		},
		{
			name: "owner-star-outbound",
			actor: "owner",
			action: "star",
			method: "POST",
			status: "sent",
			direction: "outbound",
		},
		{
			name: "owner-snooze-outbound",
			actor: "owner",
			action: "snooze",
			method: "POST",
			until: future,
			status: "sent",
			direction: "outbound",
		},
		{
			name: "owner-unsnooze-outbound",
			actor: "owner",
			action: "snooze",
			method: "DELETE",
			status: "sent",
			direction: "outbound",
		},
		{
			name: "owner-snooze-archived",
			actor: "owner",
			action: "snooze",
			method: "POST",
			until: future,
			status: "archived",
		},
		{
			name: "owner-unsnooze-archived",
			actor: "owner",
			action: "snooze",
			method: "DELETE",
			status: "archived",
		},
		{
			name: "missing-read",
			actor: "owner",
			action: "read",
			method: "POST",
			messageId: "missing",
		},
		{
			name: "missing-star",
			actor: "owner",
			action: "star",
			method: "POST",
			messageId: "missing",
		},
		{
			name: "missing-snooze-invalid",
			actor: "owner",
			action: "snooze",
			method: "POST",
			until: "bad date",
			messageId: "missing",
		},
		{
			name: "missing-snooze-valid",
			actor: "owner",
			action: "snooze",
			method: "POST",
			until: future,
			messageId: "missing",
		},
		{
			name: "sharing-disabled-star",
			actor: "stranger",
			permission: "read_only",
			action: "star",
			method: "POST",
			team: false,
		},
		{
			name: "personal-mailbox-star",
			actor: "stranger",
			permission: "read_only",
			action: "star",
			method: "POST",
			personal: true,
		},
	);
	for (const action of ["read", "star", "snooze"] as const)
		cases.push({
			name: `disabled-mailbox-${action}`,
			actor: "owner",
			action,
			method: "POST",
			until: future,
			disabled: 1,
		});
	const captured = [];
	for (const sample of cases) {
		db.exec(
			"DELETE FROM audit_logs; DELETE FROM mailbox_access; INSERT INTO license_settings(id,instance_id,plan,state,updated_at) VALUES('default','fixture','team','active',1) ON CONFLICT(id) DO UPDATE SET plan='team',state='active'; INSERT OR IGNORE INTO folders(id,user_id,mailbox_id,name,created_at) VALUES('action-folder','owner','mailbox','Action folder',1)",
		);
		db.query("UPDATE mailboxes SET type=?,disabled=? WHERE id='mailbox'").run(
			sample.personal ? "personal" : "shared",
			sample.disabled ?? 0,
		);
		if (sample.team === false)
			db.exec("UPDATE license_settings SET plan='free' WHERE id='default'");
		db.query(
			"UPDATE messages SET status=?,direction=?,folder_id='action-folder',snoozed_until=4000000000,read=?,starred=? WHERE id='message'",
		).run(
			sample.status ?? "received",
			sample.direction ?? "inbound",
			sample.read ?? 0,
			sample.starred ?? 0,
		);
		db.exec("UPDATE messages SET trashed_at=123 WHERE id='message'");
		if (sample.permission)
			db.query(
				"INSERT INTO mailbox_access(id,mailbox_id,user_id,permission,created_at) VALUES('action-share','mailbox','stranger',?,1)",
			).run(sample.permission);
		const response = await fetch(
			`${base}/api/messages/${sample.messageId ?? "message"}/${sample.action}`,
			{
				method: sample.method,
				headers: {
					Origin: base,
					Authorization: "Bearer " + tokens[sample.actor],
					"Content-Type": "application/json",
				},
				body:
					sample.action === "snooze" && sample.method === "POST"
						? JSON.stringify({ snoozedUntil: sample.until })
						: "not JSON",
			},
		);
		captured.push({
			...sample,
			response: { status: response.status, body: await response.json() },
			message: db
				.query(
					"SELECT status,direction,folder_id,snoozed_until,trashed_at,starred,read FROM messages WHERE id='message'",
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
	const sourceHashes: Record<string, string> = {};
	for (const file of [
		"src/app/api/messages/[messageId]/read/route.ts",
		"src/app/api/messages/[messageId]/star/route.ts",
		"src/app/api/messages/[messageId]/snooze/route.ts",
		"src/app/api/messages/[messageId]/snooze/utils.ts",
		"src/lib/user.ts",
		"src/lib/mailboxes/access.ts",
		"src/lib/mailboxes/audit.ts",
	])
		sourceHashes[file] = new Bun.CryptoHasher("sha256")
			.update(await Bun.file(join(reference, file)).text())
			.digest("hex");
	await Bun.write(
		"tests/source-message-actions.json",
		JSON.stringify(
			{
				sourceRevision: "71aa49b",
				sourceVersion: "0.5.2",
				sourceHashes,
				cases: captured,
			},
			null,
			2,
		) + "\n",
	);
	console.log(
		`Captured ${captured.length} original message-action responses, grants and persisted effects.`,
	);
} finally {
	db.close();
}
