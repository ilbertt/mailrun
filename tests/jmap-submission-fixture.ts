import type { Database } from "bun:sqlite";
import {
	prepareV1Send,
	V1_TOKEN,
	v1SendSnapshot,
	type V1SendSample,
} from "./v1-send-fixture";
import {
	CAPABILITY_CORE,
	CAPABILITY_MAIL,
	CAPABILITY_SUBMISSION,
} from "../src/server/jmap/constants";
import type { JmapInvocation } from "../src/server/jmap/types";
export type JmapSubmissionSample = Omit<V1SendSample, "fields" | "auth"> & {
	auth?: "none" | "basic" | "invalid" | "trimmed";
	method?: string;
	args?: Record<string, unknown>;
	calls?: JmapInvocation[];
	createdIds?: Record<string, string>;
	failFirst?: boolean;
};
export const JMAP_SUBMISSION_ORIGIN = "https://jmap-submit-fixture.example";
export const JMAP_IDENTITY = "mailbox~hello@example.com";
export const submissionFields = {
	create: { submission: { emailId: "draft", identityId: JMAP_IDENTITY } },
};
export const jmapSubmissionSamples: JmapSubmissionSample[] = [];
for (const role of [
	"owner",
	"read_only",
	"send_on_behalf",
	"send_as",
	"full_access",
	"unknown",
	"unshared",
])
	jmapSubmissionSamples.push({
		name: "role-" + role,
		actor: role === "owner" ? "owner" : "stranger",
		permission: ["owner", "unshared"].includes(role) ? undefined : role,
	});
for (const variant of [
	"disabled-box",
	"personal-box",
	"no-team",
	"disabled-user",
	"deleted-key",
])
	jmapSubmissionSamples.push({
		name: variant,
		variant,
		actor: ["personal-box", "no-team"].includes(variant) ? "stranger" : "owner",
		permission: "full_access",
	});
for (const auth of ["none", "basic", "invalid", "trimmed"] as const)
	jmapSubmissionSamples.push({ name: "auth-" + auth, auth });
for (const scopes of [
	["read"],
	["*"],
	["jmap"],
	["jmap", "send"],
	["jmap", "mailboxes"],
	[],
])
	jmapSubmissionSamples.push({ name: "scopes-" + scopes.join(","), scopes });
for (const scope of ["empty", "other", "all"] as const)
	jmapSubmissionSamples.push({ name: "mailbox-scope-" + scope, scope });
jmapSubmissionSamples.push({
	name: "mcp-legacy-unrestricted",
	kind: "mcp",
	scope: "all",
});
for (const [name, method, args] of [
	["identity-all", "Identity/get", {}],
	[
		"identity-filtered",
		"Identity/get",
		{ ids: [JMAP_IDENTITY, "mailbox~named@example.com", "missing"] },
	],
	["identity-properties", "Identity/get", { properties: ["email"] }],
	["identity-changes", "Identity/changes", { sinceState: "old" }],
	[
		"identity-mutations",
		"Identity/set",
		{
			create: { a: { email: "new@example.com" } },
			update: { missing: { name: "New" } },
			destroy: ["old"],
		},
	],
	["submission-get", "EmailSubmission/get", { ids: ["draft", "missing"] }],
	["submission-query", "EmailSubmission/query", {}],
	["submission-changes", "EmailSubmission/changes", { sinceState: "old" }],
	[
		"submission-query-changes",
		"EmailSubmission/queryChanges",
		{ sinceQueryState: "old" },
	],
	["empty-set", "EmailSubmission/set", {}],
	[
		"unsupported-mutations",
		"EmailSubmission/set",
		{ update: { missing: { undoStatus: "canceled" } }, destroy: ["old"] },
	],
	[
		"missing-identity",
		"EmailSubmission/set",
		{ create: { submission: { emailId: "draft" } } },
	],
	[
		"invalid-identity",
		"EmailSubmission/set",
		{
			create: {
				submission: { emailId: "draft", identityId: "not-an-identity" },
			},
		},
	],
	[
		"wrong-identity-address",
		"EmailSubmission/set",
		{
			create: {
				submission: {
					emailId: "draft",
					identityId: "mailbox~wrong@example.com",
				},
			},
		},
	],
	[
		"alias-identity",
		"EmailSubmission/set",
		{
			create: {
				submission: {
					emailId: "draft",
					identityId: "mailbox~named@example.com",
				},
			},
		},
	],
	[
		"missing-email",
		"EmailSubmission/set",
		{ create: { submission: { identityId: JMAP_IDENTITY } } },
	],
	[
		"unknown-email",
		"EmailSubmission/set",
		{
			create: { submission: { emailId: "missing", identityId: JMAP_IDENTITY } },
		},
	],
	[
		"wrong-account",
		"EmailSubmission/set",
		{ ...submissionFields, accountId: "other" },
	],
	[
		"duplicate-submissions",
		"EmailSubmission/set",
		{
			create: {
				first: { emailId: "draft", identityId: JMAP_IDENTITY },
				second: { emailId: "draft", identityId: JMAP_IDENTITY },
			},
		},
	],
	[
		"success-options",
		"EmailSubmission/set",
		{
			...submissionFields,
			onSuccessDestroyEmail: ["#submission"],
			onSuccessUpdateEmail: { "#submission": { keywords: { $seen: true } } },
		},
	],
] as const)
	jmapSubmissionSamples.push({ name, method, args });
for (const variant of [
	"no-file",
	"missing-file",
	"trashed-file",
	"wrong-size",
	"file-count",
	"file-limit",
	"foreign-draft",
	"wrong-mailbox",
	"sent-draft",
	"inbound-draft",
	"null-subject",
	"empty-subject",
	"long-subject",
	"too-long-subject",
	"empty-to",
	"invalid-to",
	"single-label-to",
	"empty-body",
	"html-only",
	"threading",
	"duplicates",
	"dirty-filename",
	"upper-type",
	"inline-no-cid",
	"attachment-cid",
	"raw-mime",
	"agent",
	"cleanup-failure",
	"database-cleanup-failure",
])
	jmapSubmissionSamples.push({ name: variant, variant });
jmapSubmissionSamples.push(
	{
		name: "unknown-grant-identities",
		actor: "stranger",
		permission: "unknown",
		method: "Identity/get",
		args: {},
	},
	{ name: "provider-failure", failure: true },
	{
		name: "first-fails-retry",
		failFirst: true,
		args: {
			create: {
				first: { emailId: "draft", identityId: JMAP_IDENTITY },
				second: { emailId: "draft", identityId: JMAP_IDENTITY },
			},
		},
	},
	{
		name: "created-reference",
		createdIds: { existing: "draft" },
		args: {
			create: {
				submission: { emailId: "#existing", identityId: JMAP_IDENTITY },
			},
		},
	},
	{
		name: "multiple-methods",
		calls: [
			["Identity/get", {}, "i"],
			["EmailSubmission/set", submissionFields, "s"],
			["EmailSubmission/query", {}, "q"],
			["EmailSubmission/get", { ids: ["#submission"] }, "g"],
		],
	},
);
if (
	new Set(jmapSubmissionSamples.map((row) => row.name)).size !==
	jmapSubmissionSamples.length
)
	throw new Error("Duplicate JMAP submission case");
export function jmapSubmissionRequest(
	sample: JmapSubmissionSample,
	base = JMAP_SUBMISSION_ORIGIN,
) {
	const authorization =
		sample.auth === "none"
			? undefined
			: sample.auth === "basic"
				? "Basic " + btoa("ignored:" + V1_TOKEN)
				: sample.auth === "invalid"
					? "Bearer ep_wrong_fixture_key"
					: sample.auth === "trimmed"
						? "Bearer  " + V1_TOKEN + "  "
						: "Bearer " + V1_TOKEN;
	const headers = new Headers({ "Content-Type": "application/json" });
	if (authorization) headers.set("Authorization", authorization);
	return new Request(base + "/jmap/api", {
		method: "POST",
		headers,
		body: JSON.stringify({
			using: [CAPABILITY_CORE, CAPABILITY_MAIL, CAPABILITY_SUBMISSION],
			methodCalls: sample.calls ?? [
				[
					sample.method ?? "EmailSubmission/set",
					sample.args ?? submissionFields,
					"s",
				],
			],
			...(sample.createdIds ? { createdIds: sample.createdIds } : {}),
		}),
	});
}
export async function prepareJmapSubmission(
	db: Database,
	directory: string,
	sample: JmapSubmissionSample,
) {
	db.exec("DROP TRIGGER IF EXISTS fail_draft_cleanup");
	await prepareV1Send(db, directory, {
		...sample,
		auth: undefined,
		scopes: sample.scopes ?? ["jmap"],
	});
	const actor = sample.actor ?? "owner";
	db.query(
		"INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,snippet,text_body,html_body,status,read,starred,thread_id,in_reply_to,references_header,created_at) VALUES('draft',?,'mailbox','outbound','hello@example.com','maya@example.net','Original draft','Before','Before','<p>Before</p>','draft',1,1,'draft-thread','<draft-parent@example.org>','<draft-root@example.org>',1)",
	).run(actor);
	db.exec(
		"INSERT INTO message_attachments(id,message_id,filename,content_type,size,r2_key,disposition,content_id,created_at) VALUES('stored-file','draft','stored.txt','text/plain',6,'stored.txt','inline','source-cid',1)",
	);
	const updates: Record<string, string> = {
		"no-file": "DELETE FROM message_attachments",
		"trashed-file": "UPDATE message_attachments SET trashed_at=1",
		"wrong-size": "UPDATE message_attachments SET size=30000000",
		"foreign-draft": "UPDATE messages SET user_id='stranger'",
		"wrong-mailbox":
			"INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES('second-box','owner','domain','second','personal',1);UPDATE messages SET mailbox_id='second-box'",
		"sent-draft": "UPDATE messages SET status='sent'",
		"inbound-draft": "UPDATE messages SET direction='inbound'",
		"null-subject": "UPDATE messages SET subject=NULL",
		"empty-subject": "UPDATE messages SET subject=''",
		"empty-to": "UPDATE messages SET to_addr=''",
		"invalid-to": "UPDATE messages SET to_addr='invalid'",
		"single-label-to": "UPDATE messages SET to_addr='recipient@internal'",
		"empty-body": "UPDATE messages SET text_body=NULL,html_body=NULL",
		"html-only": "UPDATE messages SET text_body=NULL",
		threading:
			"UPDATE messages SET cc_addr='Copy <cc@example.net>',bcc_addr='hidden@example.net',in_reply_to='parent@example.net',references_header='<root@example.net> <parent@example.net>'",
		duplicates:
			"UPDATE messages SET to_addr='Maya <maya@example.net>, Other <MAYA@example.net>, second@example.net'",
		"dirty-filename":
			"UPDATE message_attachments SET filename=' ../folder\\note.txt '",
		"upper-type": "UPDATE message_attachments SET content_type='TEXT/PLAIN'",
		"inline-no-cid": "UPDATE message_attachments SET content_id=NULL",
		"attachment-cid": "UPDATE message_attachments SET disposition='attachment'",
		"raw-mime": "UPDATE messages SET raw_r2_key='source.eml'",
		agent:
			"INSERT INTO agent_draft_metadata(draft_id,mailbox_id,origin,revision,created_at) VALUES('draft','mailbox','manual',3,1)",
	};
	if (sample.variant && updates[sample.variant])
		db.exec(updates[sample.variant]!);
	if (
		sample.variant === "long-subject" ||
		sample.variant === "too-long-subject"
	)
		db.query("UPDATE messages SET subject=?").run(
			"S".repeat(sample.variant === "long-subject" ? 750 : 999),
		);
	if (sample.variant === "file-count")
		for (let n = 0; n < 10; n++) {
			db.query(
				"INSERT INTO message_attachments(id,message_id,filename,content_type,size,r2_key,disposition,created_at) VALUES(?,'draft','copy.txt','text/plain',6,?,'attachment',1)",
			).run("extra-file-" + n, "copy-" + n + ".txt");
			await Bun.write(directory + "/blobs/copy-" + n + ".txt", "stored");
		}
	if (sample.variant === "missing-file")
		await Bun.file(directory + "/blobs/stored.txt").delete();
	if (sample.variant === "raw-mime")
		await Bun.write(directory + "/blobs/source.eml", "Synthetic raw MIME");
	if (sample.variant === "database-cleanup-failure")
		db.exec(
			"CREATE TRIGGER fail_draft_cleanup BEFORE DELETE ON messages WHEN OLD.id='draft' BEGIN SELECT RAISE(ABORT,'Synthetic draft cleanup failure'); END",
		);
	// Revision tokens are observable: compare exact write deltas from the same seed.
	db.exec(
		"DELETE FROM jmap_mailbox_revisions;INSERT INTO jmap_mailbox_revisions(mailbox_id,revision) SELECT id,100 FROM mailboxes",
	);
}
export async function jmapSubmissionSnapshot(
	db: Database,
	directory: string,
	response: Response,
	started: number,
	deliveries: unknown[],
) {
	// sendAt has subsecond precision; preserve state tokens and every other value.
	const body: unknown = await response.json();
	function normalize(value: unknown, key = ""): unknown {
		if (
			key === "sendAt" &&
			typeof value === "string" &&
			Number.isFinite(Date.parse(value)) &&
			Date.parse(value) >= started * 1000 &&
			Date.parse(value) <= Date.now() + 1000
		)
			return "$now";
		if (Array.isArray(value)) return value.map((item) => normalize(item));
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([name, item]) => [
					name,
					normalize(item, name),
				]),
			);
		return value;
	}
	return v1SendSnapshot(
		db,
		directory,
		Response.json(normalize(body), { status: response.status }),
		started,
		deliveries,
	);
}
