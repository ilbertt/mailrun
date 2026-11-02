import type { Database } from "bun:sqlite";
import { prepareSendFixture, sendSnapshot } from "./send-contract-fixture";
import { normalizeEmailAddress } from "../src/lib/email/address";
export type AutoReplySample = {
	name: string;
	headers?: Record<string, string>;
	from?: string;
	delivered?: string;
	messageId?: string | null;
	variant?: string;
	failure?: boolean;
};
export const autoReplySamples: AutoReplySample[] = [
	{ name: "ordinary" },
	{ name: "no-message-id", messageId: null },
	{ name: "inner-address-space", from: "Maya < MAYA@example.net >" },
	{ name: "delivered-address-space", delivered: "  hello@example.com  " },
	{ name: "bare-message-id", messageId: "incoming@example.net" },
	{
		name: "delivered-cross-domain",
		variant: "cross-domain",
		delivered: "hello@second.example",
	},
	{
		name: "delivered-cross-domain-dot",
		variant: "cross-domain",
		delivered: "h.e.l.l.o@second.example",
	},
	{
		name: "delivered-cross-domain-plus",
		variant: "cross-domain",
		delivered: "hello+tag@second.example",
	},
	{
		name: "delivered-own-alias",
		variant: "own-alias",
		delivered: "named@example.com",
	},
];
for (const from of [
	"sender@example.net",
	"Maya <MAYA@example.net>",
	"not an address",
	"hello@example.com",
	"h.e.l.l.o+tag@example.com",
	"mailer-daemon@example.net",
	"postmaster@example.net",
	"noreply@example.net",
	"no-reply@example.net",
	"do-not-reply@example.net",
	"noreply+tag@example.net",
])
	autoReplySamples.push({ name: "sender-" + from, from });
for (const [name, headers] of [
	["submitted", { "auto-submitted": "auto-generated" }],
	["submitted-caps", { "Auto-Submitted": "auto-replied" }],
	["submitted-no", { "Auto-Submitted": " No " }],
	["bulk", { precedence: "bulk" }],
	["bulk-caps", { Precedence: " Bulk " }],
	["junk", { precedence: "junk" }],
	["list", { precedence: "list" }],
	["personal", { precedence: "personal" }],
	["list-id", { "list-id": "list.example" }],
	["list-id-caps", { "List-Id": "list.example" }],
	["empty-list", { "List-Id": "  " }],
	["autoreply", { "X-Autoreply": "yes" }],
	["autorespond", { "X-Autorespond": "yes" }],
	["suppress", { "X-Auto-Response-Suppress": "All" }],
] as const)
	autoReplySamples.push({ name: "header-" + name, headers });
for (const variant of [
	"disabled-reply",
	"empty-body",
	"blank-subject",
	"trim-body",
	"recent",
	"old",
	"manual-contact",
	"personal",
	"own-alias",
	"own-domain-alias",
])
	autoReplySamples.push({
		name: variant,
		variant,
		from:
			variant === "own-alias"
				? "named@example.com"
				: variant === "own-domain-alias"
					? "hello@second.example"
					: undefined,
	});
autoReplySamples.push({ name: "provider-failure", failure: true });
if (
	new Set(autoReplySamples.map((sample) => sample.name)).size !==
	autoReplySamples.length
)
	throw new Error("Duplicate automatic-reply case");
export const autoReplyInput = (sample: AutoReplySample) => ({
	mailboxId: "mailbox",
	userId: "owner",
	deliveredAddress: sample.delivered ?? "hello@example.com",
	fromAddress: sample.from ?? "Maya <maya@example.net>",
	incomingMessageId:
		sample.messageId === undefined
			? "<incoming@example.net>"
			: sample.messageId,
	headers: sample.headers ?? {},
});
export async function prepareAutoReply(
	db: Database,
	directory: string,
	sample: AutoReplySample,
) {
	await prepareSendFixture(db, directory, { name: sample.name, kind: "send" });
	db.exec(
		"DELETE FROM routing_rules;DELETE FROM auto_reply_deliveries;DELETE FROM domains WHERE id<>'domain';UPDATE users SET name='Owner',avatar_key=NULL WHERE id='owner';UPDATE mailboxes SET use_all_domains=0;DELETE FROM message_attachments;DELETE FROM outbound_jobs;DELETE FROM messages;UPDATE mailboxes SET auto_reply_enabled=1,auto_reply_subject='  Away  ',auto_reply_body='  Back tomorrow  ' WHERE id='mailbox'",
	);
	const recipient = normalizeEmailAddress(autoReplyInput(sample).fromAddress);
	db.query(
		"INSERT INTO contacts(id,user_id,email,display_name,source,last_seen_at,created_at) VALUES(?,'owner',?,'Maya','inbound',1,1) ON CONFLICT(user_id,email) DO UPDATE SET display_name='Maya',source='inbound',last_seen_at=1,created_at=1",
	).run("owner:" + recipient, recipient);
	if (sample.variant === "manual-contact")
		db.exec("UPDATE contacts SET source='manual'");
	if (sample.variant === "disabled-reply")
		db.exec("UPDATE mailboxes SET auto_reply_enabled=0");
	if (sample.variant === "empty-body")
		db.exec("UPDATE mailboxes SET auto_reply_body='  '");
	if (sample.variant === "blank-subject")
		db.exec("UPDATE mailboxes SET auto_reply_subject='  '");
	if (sample.variant === "trim-body")
		db.exec("UPDATE mailboxes SET auto_reply_body='  Line 1\n\n Line 2  '");
	if (sample.variant === "personal")
		db.exec(
			"UPDATE mailboxes SET type='personal',display_name='Old primary'; UPDATE users SET name='Account identity' WHERE id='owner'",
		);
	if (sample.variant === "recent" || sample.variant === "old")
		db.query(
			"INSERT INTO auto_reply_deliveries(id,mailbox_id,recipient,sent_at) VALUES('existing-delivery','mailbox',?,?)",
		).run(
			recipient,
			Math.floor(Date.now() / 1000) -
				(sample.variant === "recent" ? 86390 : 86410),
		);
	if (sample.variant === "own-alias")
		db.exec(
			"INSERT INTO mailbox_aliases(id,mailbox_id,domain_id,local_part,created_at) VALUES('named','mailbox','domain','named',1)",
		);
	if (sample.variant === "cross-domain")
		db.exec(
			"INSERT INTO domains(id,user_id,hostname,zone_id,status,sending_enabled,sending_provider,created_at) VALUES('second','owner','second.example','manual','active',1,'cloudflare',1);UPDATE mailboxes SET use_all_domains=1",
		);
	if (sample.variant === "own-domain-alias")
		db.exec(
			"INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('second','owner','second.example','manual','active',1); UPDATE mailboxes SET use_all_domains=1",
		);
}
export async function autoReplySnapshot(
	db: Database,
	directory: string,
	response: Response,
	started: number,
	deliveries: unknown[],
) {
	const snapshot = await sendSnapshot(
		db,
		directory,
		response,
		started,
		deliveries,
	);
	const records = db
		.query(
			"SELECT id,mailbox_id,recipient,sent_at FROM auto_reply_deliveries ORDER BY recipient",
		)
		.all() as {
		id: string;
		mailbox_id: string;
		recipient: string;
		sent_at: number;
	}[];
	const normalizedRecords = records.map((row) => ({
		...row,
		id: row.id === "existing-delivery" ? row.id : "$delivery",
		sent_at:
			row.sent_at >= started
				? "$now"
				: row.sent_at >= started - 86400
					? "$recent"
					: "$old",
	}));
	function normalize(value: unknown, key = ""): unknown {
		if (Array.isArray(value)) return value.map((x) => normalize(x));
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value)
					.filter(
						([k]) => !["autoReplyMailboxId", "autoReplyRecipient"].includes(k),
					)
					.map(([k, v]) => [k, normalize(v, k)]),
			);
		return value;
	}
	return { snapshot: normalize(snapshot), records: normalizedRecords };
}
