// Generate synthetic migration evidence using the unmodified Mailflare baseline.
// bun scripts/capture-source-outbound.ts /path/to/mailflare-71aa49b /tmp/capture.json
// Requires that reference checkout's installed Node dependencies; never sends mail.
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { capturedMailSchema } from "../tests/source-outbound-fixture";

if (!process.argv[2] || !process.argv[3])
	throw new Error("Expected reference checkout and output JSON path");
const source = resolve(process.argv[2]);
const destination = resolve(process.argv[3]);
const digest = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
const provenance = {
	source: "71aa49b",
	version: "0.5.2",
	sendModuleSha256: digest(
		await readFile(join(source, "src/lib/email/send.ts")),
	),
	backupModuleSha256: digest(
		await readFile(join(source, "src/lib/backups/export.ts")),
	),
};
if (
	provenance.sendModuleSha256 !==
		"380f25f360f45480c681668c66aab057bd3b84c7cb00831a3e3c5863d7c59ff3" ||
	provenance.backupModuleSha256 !==
		"aff55286a3c6c8b77750751cb9f4ea9c3b1b3649a6235f03d2d6154d3bf136d8"
)
	throw new Error(
		"Reference sender/exporter differs from the pinned Mailflare baseline",
	);
const require = createRequire(join(source, "package.json"));
type ReferenceBuildOptions = {
	entryPoints: string[];
	outfile: string;
	bundle: true;
	platform: "node";
	format: "esm";
	target: "node22";
	tsconfig: string;
	external: string[];
	alias: Record<string, string>;
	banner: { js: string };
	define: Record<string, string>;
	logLevel: "warning";
};
const { build } = z
	.object({
		build: z.custom<(options: ReferenceBuildOptions) => Promise<unknown>>(
			(value) => typeof value === "function",
		),
	})
	.parse(require("esbuild"));
const node = Bun.which("node");
if (!node)
	throw new Error(
		"The original better-sqlite3 runtime needs Node for reference capture",
	);
const directory = await mkdtemp(join(source, ".mailrun-outbound-capture-"));
try {
	const helper = `
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {SqliteDatabase} from 'original-database';
import {FileBucket} from 'original-bucket';
import {sendEmail,processOutboundQueue} from 'original-send';
import {exportDatabaseRecords} from 'original-backup';
const dir=process.argv[2],ref=process.argv[3];
const db=new SqliteDatabase(join(dir,'source.sqlite'));
const files=(await (await import('node:fs/promises')).readdir(ref+'/drizzle/migrations')).filter(x=>x.endsWith('.sql')).sort();
for(const name of files)db.db.exec(await readFile(join(ref,'drizzle/migrations',name),'utf8'));
db.db.exec("INSERT INTO users(id,email,name,password_hash,role,is_primary_admin,created_at) VALUES('owner','owner@example.com','Owner','test-only','admin',1,1); INSERT INTO domains(id,user_id,hostname,zone_id,status,sending_enabled,sending_provider,created_at) VALUES('domain','owner','example.com','zone','active',1,'cloudflare',1); INSERT INTO mailboxes(id,user_id,domain_id,local_part,created_at) VALUES('mailbox','owner','domain','hello',1); INSERT INTO mailbox_aliases(id,mailbox_id,domain_id,local_part,created_at) VALUES('source-alias','mailbox','domain','support',1)");
const bucket=new FileBucket(join(dir,'blobs'));
const queue=[];
let externalRequests=0;
globalThis.fetch=async()=>{externalRequests++;return new Response('',{status:404});};
const env={DB:db,BUCKET:bucket,OUTBOUND_QUEUE:{send:async(job)=>queue.push(job)},EMAIL:{send:async()=>{throw new Error('A future source job must not send immediately');}}};
const cases=[
 {label:'references-array',references:['<root@example.org>',' <parent@example.org> ','<parent@example.org>'],headers:{'X-Migration-Proof':'source-array'}},
 {label:'references-string',references:'<root@example.org>, <parent@example.org>',headers:{'Auto-Submitted':'auto-replied','X-Auto-Response-Suppress':'All'}},
 {label:'long-references',references:Array.from({length:65},(_,i)=>'<'+String(i).padStart(2,'0')+'-'+'A'.repeat(48)+'@example.org>'),headers:{'X-Migration-Proof':'source-long-chain'}},
];
const results=[];
for(const item of cases){
 const content=new TextEncoder().encode('Original scheduled attachment '+item.label+' café\\n');
 const result=await sendEmail(env,{userId:'owner',mailboxId:'mailbox',from:'support@example.com',to:['Maya <maya@example.net>'],cc:'Copy <copy@example.net>',bcc:['hidden@example.net'],subject:'Source queued '+item.label,text:'Original queued body '+item.label,html:'<p>Original queued <img src="cid:source-image"></p>',inReplyTo:'<parent@example.org>',references:item.references,threadId:'source-thread',headers:item.headers,attachments:[{filename:'source-'+item.label+'.txt',type:'text/plain',content:content.buffer,disposition:'inline',contentId:'source-image'}],scheduledAt:'2100-01-01T12:00:00.000Z',publicOrigin:'https://source.example.com'});
 results.push({label:item.label,...result});
}
await writeFile(join(dir,'backup.json'),await exportDatabaseRecords(db));
await writeFile(join(dir,'result.json'),JSON.stringify({results,queue,interceptedFetches:externalRequests}));
const deliveries=[];
env.EMAIL.send=async(message)=>{deliveries.push({...message,attachments:message.attachments?.map(file=>({...file,content:Buffer.from(file.content).toString('base64')}))});return {messageId:'<source-delivery-'+deliveries.length+'@example.com>'};};
for(const job of queue){db.db.prepare('UPDATE outbound_jobs SET scheduled_at=0 WHERE id=?').run(job.jobId);await processOutboundQueue(env,{...job,scheduledAt:'2000-01-01T00:00:00.000Z'});}
await writeFile(join(dir,'expected.json'),JSON.stringify({deliveries,audits:db.db.prepare("SELECT actor_user_id,mailbox_id,message_id,action,metadata FROM audit_logs WHERE action='email.send' ORDER BY rowid").all()}));
db.db.close();
`;
	const input = join(directory, "capture.ts"),
		bundle = join(directory, "capture.mjs");
	await writeFile(input, helper);
	await build({
		entryPoints: [input],
		outfile: bundle,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		tsconfig: join(source, "tsconfig.json"),
		external: [
			"next",
			"better-sqlite3",
			"nodemailer",
			"smtp-server",
			"ws",
			"react",
			"react-dom",
		],
		alias: {
			"cloudflare:workers": join(
				source,
				"server/runtime/cloudflare-workers.ts",
			),
			"original-send": join(source, "src/lib/email/send.ts"),
			"original-database": join(source, "server/runtime/sqlite-database.ts"),
			"original-bucket": join(source, "server/runtime/file-bucket.ts"),
			"original-backup": join(source, "src/lib/backups/export.ts"),
		},
		banner: {
			js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
		},
		define: { "process.env.MAILFLARE_RUNTIME": '"node"' },
		logLevel: "warning",
	});
	execFileSync(node, [bundle, directory, source], {
		stdio: "inherit",
		timeout: 30000,
	});
	const backup: unknown = JSON.parse(
		await readFile(join(directory, "backup.json"), "utf8"),
	);
	const results = z
		.object({
			queue: z.array(
				z.object({
					kind: z.literal("email.scheduled"),
					jobId: z.string(),
					messageId: z.string(),
					scheduledAt: z.string(),
				}),
			),
		})
		.parse(JSON.parse(await readFile(join(directory, "result.json"), "utf8")));
	const expected = z
		.object({
			deliveries: z.array(capturedMailSchema),
			audits: z.array(
				z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
			),
		})
		.parse(
			JSON.parse(await readFile(join(directory, "expected.json"), "utf8")),
		);
	const objects: {
		key: string;
		base64: string;
		sha256: string;
		metadata: unknown;
	}[] = [];
	const bucket = join(directory, "blobs");
	for (const name of await readdir(bucket, { recursive: true })) {
		if (name.endsWith(".meta.json")) continue;
		const { stat } = await import("node:fs/promises");
		if (!(await stat(join(bucket, name))).isFile()) continue;
		const bytes = await readFile(join(bucket, name));
		objects.push({
			key: name.split("\\").join("/"),
			base64: bytes.toString("base64"),
			sha256: digest(bytes),
			metadata: JSON.parse(
				await readFile(join(bucket, name + ".meta.json"), "utf8"),
			),
		});
	}
	objects.sort((a, b) => a.key.localeCompare(b.key));
	await writeFile(
		destination,
		JSON.stringify(
			{ provenance, backup, queue: results.queue, objects, expected },
			null,
			2,
		) + "\n",
	);
	console.log(
		JSON.stringify({
			capturedJobs: results.queue.length,
			capturedObjects: objects.length,
			capturedDeliveries: expected.deliveries.length,
			externalRequests: 0,
		}),
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
