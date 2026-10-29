import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { fixture, owner, stranger } from "./fixtures";
import {
	addAlias,
	saveRule,
	setForwarding,
} from "../src/server/mail/management";
import { resolveRouting } from "../src/server/mail/routing";
import { inbound, storeInbound } from "../src/server/mail/inbound";
import relay from "../relay/index";

let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
const raw = (extra = "") =>
	new TextEncoder().encode(
		`From: sender@example.org\r\nSubject: Invoice\r\n${extra}\r\nAn invoice message`,
	);
const rule = (overrides: Record<string, unknown> = {}) => ({
	domainId: "domain",
	scope: "domain" as const,
	name: "Catch all",
	enabled: true,
	matchField: "recipient" as const,
	matchOperator: "contains" as const,
	matchValue: "*",
	action: "store" as const,
	mailboxId: "mailbox",
	keepCopy: false,
	forwardTo: "",
	rejectReason: "",
	priority: 0,
	...overrides,
});
test("exact and explicit aliases win over a catch-all; plus/dot normalization is preserved", async () => {
	await addAlias(owner, {
		mailboxId: "mailbox",
		domainId: "domain",
		localPart: "support",
	});
	await saveRule(
		owner,
		rule({ action: "forward", forwardTo: "elsewhere@example.net" }),
	);
	expect((await resolveRouting("h.e.l.l.o+tag@example.com"))?.action).toBe(
		"store",
	);
	expect((await resolveRouting("s.up.port+tag@example.com"))?.mailbox?.id).toBe(
		"mailbox",
	);
	expect((await resolveRouting("unknown@example.com"))?.action).toBe("forward");
});
test("sender block rules precede exact addresses and invalid/unsafe regex cannot be saved", async () => {
	await saveRule(
		owner,
		rule({
			action: "reject",
			mailboxId: null,
			matchField: "sender",
			matchOperator: "exact",
			matchValue: "blocked@example.org",
			rejectReason: "Blocked sender",
		}),
	);
	expect(
		await resolveRouting("hello@example.com", "blocked@example.org"),
	).toEqual({ action: "reject", reason: "Blocked sender" });
	await expect(
		saveRule(owner, rule({ matchOperator: "regex", matchValue: "(a+)+$" })),
	).rejects.toThrow("unsafe");
});
test("cross-domain aliases stay within a domain owner and explicit assignments take precedence", async () => {
	state.db.exec(
		"INSERT INTO domains (id,user_id,hostname,zone_id,status,created_at) VALUES ('other','owner','other.example','zone','active',1),('foreign','stranger','foreign.example','zone','active',1)",
	);
	expect((await resolveRouting("hello@other.example"))?.mailbox?.id).toBe(
		"mailbox",
	);
	expect(await resolveRouting("hello@foreign.example")).toBeNull();
	state.db.exec(
		"INSERT INTO mailboxes (id,user_id,domain_id,local_part,created_at) VALUES ('explicit','owner','other','hello',1)",
	);
	expect((await resolveRouting("hello@other.example"))?.mailbox?.id).toBe(
		"explicit",
	);
	await expect(
		addAlias(stranger, {
			mailboxId: "mailbox",
			domainId: "foreign",
			localPart: "steal",
		}),
	).rejects.toThrow("permission");
});
test("normalized alias collisions cannot be created concurrently", async () => {
	const results = await Promise.allSettled([
		addAlias(owner, {
			mailboxId: "mailbox",
			domainId: "domain",
			localPart: "s.ales",
		}),
		addAlias(owner, {
			mailboxId: "mailbox",
			domainId: "domain",
			localPart: "sales",
		}),
	]);
	expect(
		results.filter((result) => result.status === "fulfilled"),
	).toHaveLength(1);
	await expect(
		addAlias(owner, {
			mailboxId: "mailbox",
			domainId: "domain",
			localPart: "h.ello",
		}),
	).rejects.toThrow("assigned");
});
test("mailbox rules place matching content in Spam or a valid custom folder", async () => {
	state.db.exec(
		"INSERT INTO folders (id,user_id,mailbox_id,name,created_at) VALUES ('invoices','owner','mailbox','Invoices',1)",
	);
	await saveRule(
		owner,
		rule({
			scope: "mailbox",
			matchField: "title",
			matchValue: "invoice",
			action: "store",
			folderId: "invoices",
		}),
	);
	const result = await storeInbound(
		"sender@example.org",
		"hello@example.com",
		raw(),
	);
	expect(result.action).toBe("store");
	expect(
		state.db
			.query("SELECT folder_id FROM messages WHERE subject='Invoice'")
			.get(),
	).toEqual({ folder_id: "invoices" });
});
async function relayCase(
	keepCopy: boolean,
	fail: boolean,
	forwardedHeader = false,
) {
	state.db.exec(
		"INSERT INTO mailrun_installation(id,account_id,zone_id,hostname,worker_name,public_origin,api_token,relay_secret,relay_version,phase,updated_at) VALUES ('primary','account','zone','example.com','relay','https://mail.example.com','token','secret','v1','ready',1)",
	);
	await saveRule(
		owner,
		rule({ action: "forward", forwardTo: "destination@example.net", keepCopy }),
	);
	const bytes = raw(forwardedHeader ? "X-Mailflare-Forwarded: 1\r\n" : "");
	const forwardCalls: string[] = [];
	let rejection = "";
	const handler = Object.assign(
		async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => inbound(new Request(input, init)),
		{ preconnect: fetch.preconnect },
	);
	const mock = spyOn(globalThis, "fetch").mockImplementation(handler);
	try {
		const message: Parameters<typeof relay.email>[0] = {
			from: "sender@example.org",
			to: "unknown@example.com",
			headers: new Headers(),
			rawSize: bytes.length,
			raw: new Blob([bytes]).stream(),
			setReject(reason) {
				rejection = reason;
			},
			async forward(destination, headers) {
				forwardCalls.push(destination);
				expect(headers?.get("x-mailflare-forwarded")).toBe("1");
				if (fail) throw new Error("Forward failed");
			},
		};
		await relay.email(message, {
			MAILRUN_URL: "https://mail.example.com",
			RELAY_SECRET: "secret",
		});
		return {
			forwardCalls,
			rejection,
			stored: state.db
				.query("SELECT id FROM messages WHERE subject='Invoice'")
				.all().length,
		};
	} finally {
		mock.mockRestore();
	}
}
test("live relay forwards without a copy when requested", async () => {
	expect(await relayCase(false, false)).toMatchObject({
		forwardCalls: ["destination@example.net"],
		stored: 0,
	});
});
test("live relay keeps a requested copy and records one rule match", async () => {
	expect((await relayCase(true, false)).stored).toBe(1);
	expect(state.db.query("SELECT match_count FROM routing_rules").get()).toEqual(
		{ match_count: 1 },
	);
});
test("a failed forward preserves a fallback copy", async () => {
	expect((await relayCase(false, true)).stored).toBe(1);
});
test("loop-marked messages are stored without forwarding again", async () => {
	expect(await relayCase(true, false, true)).toMatchObject({
		forwardCalls: [],
		stored: 1,
	});
});
test("account forwarding keeps a local copy and refuses self-forwarding", async () => {
	state.db.exec(
		"INSERT INTO license_settings (id,instance_id,plan,state,updated_at) VALUES ('default','fixture','pro','active',1)",
	);
	await setForwarding(owner, "destination@example.net");
	expect(
		await storeInbound("sender@example.org", "hello@example.com", raw()),
	).toMatchObject({ action: "forward", keepCopy: true });
	await expect(setForwarding(owner, owner.email)).rejects.toThrow("differ");
});

test("domain subject rules reject MIME content before exact-address delivery", async () => {
	await saveRule(owner, {
		domainId: "domain",
		scope: "domain",
		name: "Subject block",
		enabled: true,
		matchField: "title",
		matchOperator: "contains",
		matchValue: "blocked subject",
		action: "reject",
		forwardTo: "",
		keepCopy: false,
		rejectReason: "Blocked",
		priority: 0,
	});
	const decision = await storeInbound(
		"sender@example.net",
		"hello@example.com",
		new TextEncoder().encode(
			"From: sender@example.net\r\nTo: hello@example.com\r\nSubject: A blocked subject\r\n\r\nText",
		),
	);
	expect(decision.action).toBe("reject");
});
