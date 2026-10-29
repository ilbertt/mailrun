import { resolve, join } from "node:path";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { fixture } from "../tests/fixtures";
import { getMigrations } from "../src/server/assets";
import { restoreBackup, writeBackup } from "../src/lib/backups/export";
import { LocalStorage } from "../src/server/storage";
import { seconds } from "../src/server/db";
import { hash as sessionHash } from "../src/server/auth/service";
import {
	startFixtureSetupProvider,
	writeSetupFixturePreload,
} from "../tests/setup-provider";
import sourceTables from "../tests/source-backup-tables.json";
import { z } from "zod";

const state = await fixture(),
	provider = await startFixtureSetupProvider(state.directory);
const preload = await writeSetupFixturePreload(state.directory, provider.url);
const binary = resolve(process.argv[2] ?? "dist/mailrun-local"),
	token = crypto.randomUUID();
const raw =
	"From: sender@example.org\r\nTo: hello@example.com\r\nSubject: Source import\r\n\r\nPreserve the original message bytes.\r\n";
const attachment = new TextEncoder().encode("Source attachment bytes: café\n");
const store = new LocalStorage();
await store.put("legacy/inbound.eml", raw);
await store.put("legacy/attachment.txt", attachment);
state.db
	.query(
		"INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES('import-session','owner',?,?,?)",
	)
	.run(await sessionHash(token), seconds() + 3600, seconds());
state.db.exec(
	"UPDATE domains SET routing_enabled=1,sending_requested=1; UPDATE messages SET raw_r2_key='legacy/inbound.eml' WHERE id='message'; INSERT INTO messages(id,user_id,mailbox_id,direction,status,from_addr,to_addr,subject,text_body,draft_revision,created_at) VALUES('imported-draft','owner','mailbox','outbound','draft','hello@example.com','friend@example.net','Unsent source draft','Keep editing this draft',7,1); INSERT INTO mailbox_aliases(id,mailbox_id,domain_id,local_part,created_at) VALUES('source-alias','mailbox','domain','support',1)",
);
state.db
	.query(
		"INSERT INTO message_attachments(id,message_id,filename,content_type,size,r2_key,created_at) VALUES('source-file','message','source.txt','text/plain',?,'legacy/attachment.txt',1)",
	)
	.run(attachment.byteLength);

// Use the pre-native schema and the original exporter's captured table inventory,
// rather than a native round-trip document that already contains relay state.
const legacy = new Database(join(state.directory, "source-schema.sqlite"));
let backup: string;
try {
	for (const [name, file] of getMigrations())
		if (name.endsWith(".sql") && name.slice(0, 4) < "0062")
			legacy.exec(await file.text());
	const seed = join(state.directory, "seed.json");
	await writeBackup(state.path, seed);
	restoreBackup(legacy, await Bun.file(seed).json());
	backup = JSON.stringify({
		format: "mailflare-database-backup",
		version: 1,
		createdAt: new Date().toISOString(),
		includedTables: sourceTables.tables,
		tables: Object.fromEntries(
			sourceTables.tables.map((table) => [
				table,
				legacy.query(`SELECT * FROM ${table}`).all(),
			]),
		),
	});
} finally {
	legacy.close();
}
state.db.exec(
	"DELETE FROM domains; UPDATE users SET name='Temporary target account' WHERE id='owner'",
);
await provider.cf.client.enableRouting("zone");
provider.cf.catchAlls.set("zone", {
	enabled: true,
	actions: [{ type: "worker", value: ["mailflare"] }],
	matchers: [{ type: "all" }],
});
provider.cf.rules.push({
	id: "source-address",
	enabled: true,
	actions: [{ type: "worker", value: ["mailflare"] }],
	matchers: [{ type: "literal", field: "to", value: "support@example.com" }],
});
provider.cf.rules.push({
	id: "unrelated-address",
	enabled: true,
	actions: [{ type: "worker", value: ["another-service"] }],
	matchers: [{ type: "literal", field: "to", value: "elsewhere@example.com" }],
});
let child: ReturnType<typeof Bun.spawn> | undefined,
	base = "";
const errors: Promise<string>[] = [];
const env = {
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	TMPDIR: process.env.TMPDIR,
	DATA_DIR: state.directory,
	HOST: "127.0.0.1",
	PORT: "0",
	APP_URL: provider.publicOrigin,
	CF_TOKEN: "test-cloudflare-token",
	CF_ACCOUNT_ID: "a".repeat(32),
	NODE_EXTRA_CA_CERTS: provider.cert,
	BUN_OPTIONS: "--preload " + preload.path,
};
async function start() {
	child = Bun.spawn([binary], {
		cwd: state.directory,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (
		!child.stdout ||
		typeof child.stdout === "number" ||
		typeof child.stderr === "number"
	)
		throw new Error("Missing server output");
	errors.push(new Response(child.stderr).text());
	const reader = child.stdout.getReader();
	let output = "";
	const timer = setTimeout(() => child?.kill("SIGKILL"), 15_000);
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) throw new Error("Imported fixture did not start");
			output += new TextDecoder().decode(part.value);
			const found = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
			if (found) {
				base = found;
				break;
			}
		}
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
	provider.setAppBase(base);
}
async function stop() {
	if (child) {
		child.kill("SIGTERM");
		await child.exited;
		child = undefined;
	}
}
async function call(path: string, method = "GET", body?: unknown) {
	return fetch(base + path, {
		method,
		headers: {
			Cookie: "ep_session=" + token,
			Origin: provider.publicOrigin,
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}
const digest = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
async function verifyData() {
	const original = await call("/api/messages/message/original");
	const file = await call("/api/messages/message/attachments/source-file");
	if (
		!original.ok ||
		!file.ok ||
		digest(new Uint8Array(await original.arrayBuffer())) !==
			digest(new TextEncoder().encode(raw)) ||
		digest(new Uint8Array(await file.arrayBuffer())) !== digest(attachment)
	)
		throw new Error("Imported MIME/attachment download changed");
	const draft = await call("/api/drafts/imported-draft");
	const value = z
		.object({
			draft: z.object({
				textBody: z.literal("Keep editing this draft"),
				revision: z.number(),
			}),
		})
		.safeParse(await draft.json());
	if (!draft.ok || !value.success) throw new Error("Imported draft was lost");
	if (
		state.db.query("SELECT local_part FROM mailbox_aliases").all().length !== 1
	)
		throw new Error("Imported alias was lost");
	if (state.db.query("PRAGMA foreign_key_check").all().length)
		throw new Error("Imported records failed integrity");
	return value.data.draft.revision;
}
try {
	await start();
	const form = new FormData();
	form.set(
		"backup",
		new File([backup], "source-backup.json", { type: "application/json" }),
	);
	const restored = await fetch(base + "/api/backups/restore", {
		method: "POST",
		headers: { Cookie: "ep_session=" + token, Origin: provider.publicOrigin },
		body: form,
	});
	if (!restored.ok)
		throw new Error(
			"Legacy-schema backup restore failed: " + (await restored.text()),
		);
	const importedRevision = await verifyData();
	const edited = await fetch(base + "/api/drafts/imported-draft", {
		method: "PATCH",
		headers: {
			Cookie: "ep_session=" + token,
			Origin: provider.publicOrigin,
			"Content-Type": "application/json",
			"If-Match": `"${importedRevision}"`,
		},
		body: JSON.stringify({
			mailboxId: "mailbox",
			from: "support@example.com",
			to: "friend@example.net",
			subject: "Unsent source draft",
			text: "Keep editing this draft",
		}),
	});
	if (
		!edited.ok ||
		!z
			.object({
				draft: z.object({
					fromAddr: z.literal("support@example.com"),
					revision: z.literal(importedRevision + 1),
				}),
			})
			.safeParse(await edited.json()).success
	)
		throw new Error(
			"Imported alias/draft cannot be edited with its current revision",
		);
	const dns = await call("/api/domains/domain/dns");
	if (
		!dns.ok ||
		z
			.object({
				dns: z.object({ routing: z.object({ relayReady: z.boolean() }) }),
			})
			.parse(await dns.json()).dns.routing.relayReady ||
		provider.uploads
	)
		throw new Error(
			"Reading an imported domain deployed or falsely verified a relay",
		);
	provider.setHealthy(false);
	const failed = await call(
		"/api/domains/domain/receiving/cloudflare",
		"POST",
		{ replaceMx: false },
	);
	if (failed.status !== 502)
		throw new Error(
			"Unverified imported relay did not return a recoverable provider error",
		);
	await failed.body?.cancel();
	await verifyData();
	if (
		provider.cf.catchAlls.get("zone")?.actions?.[0]?.value?.[0] !== "mailflare"
	)
		throw new Error("Failed relay verification changed the old catch-all");
	const worker = provider.workerName;
	provider.setHealthy(true);
	const connected = await call(
		"/api/domains/domain/receiving/cloudflare",
		"POST",
		{ replaceMx: false },
	);
	if (!connected.ok)
		throw new Error(
			"Imported domain relay setup failed: " + (await connected.text()),
		);
	await connected.body?.cancel();
	if (
		provider.workerName !== worker ||
		provider.cf.catchAlls.get("zone")?.actions?.[0]?.value?.[0] !== worker ||
		provider.cf.rules[0]?.actions?.[0]?.value?.[0] !== worker ||
		provider.cf.rules[1]?.actions?.[0]?.value?.[0] !== "another-service"
	)
		throw new Error(
			"Imported routing migration changed the wrong Worker rules",
		);
	await stop();
	await start();
	await verifyData();
	const ready = await call("/api/domains/domain/dns");
	if (
		!ready.ok ||
		!z
			.object({
				dns: z.object({ routing: z.object({ relayReady: z.boolean() }) }),
			})
			.parse(await ready.json()).dns.routing.relayReady
	)
		throw new Error("Imported relay binding did not survive restart");
	if (
		provider.calls.some(
			(call) =>
				call.startsWith("DELETE ") && call.includes("/workers/scripts/"),
		)
	)
		throw new Error("Source Worker was deleted");
	console.log(
		JSON.stringify(
			{
				legacySchemaBackupRestore: "passed",
				rawMimeAndAttachmentHashes: "passed",
				aliasesAndEditableDraft: "passed",
				failedHealthPreservesSourceDataAndRules: "passed",
				originalReceivingActionDeploysRelay: "passed",
				scopedRuleMigration: "passed",
				stableWorkerOnRetryAndRestart: "passed",
				externalRequests: 0,
			},
			null,
			2,
		),
	);
} finally {
	await stop();
	await provider.stop();
	await state.close();
	const stderr = (await Promise.all(errors)).join("\n");
	if (stderr.trim()) console.error(stderr);
}
