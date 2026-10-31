// Synthetic evidence from unmodified Mailflare. No external requests or email.
import {
	mkdtemp,
	cp,
	writeFile,
	readFile,
	rm,
	readdir,
	stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import {
	sourceFeatureRequests,
	sourceFeatureSession,
	readFeatureBody,
} from "../tests/source-feature-requests";

const source = resolve(z.string().min(1).parse(process.argv[2]));
const destination = resolve(z.string().min(1).parse(process.argv[3]));
const captureRestore = process.argv[4] === "--restore";
const featureSeed =
	process.argv[4] && !captureRestore ? resolve(process.argv[4]) : undefined;
const digest = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
const provenance = {
	...(featureSeed
		? { featureSeedSha256: digest(await readFile(featureSeed)) }
		: {}),
	source: "71aa49b",
	version: "0.5.2",
	blobsModuleSha256: digest(
		await readFile(join(source, "src/lib/jmap/blobs.ts")),
	),
	bucketModuleSha256: digest(
		await readFile(join(source, "server/runtime/file-bucket.ts")),
	),
	backupModuleSha256: digest(
		await readFile(join(source, "src/lib/backups/export.ts")),
	),
};
if (
	provenance.blobsModuleSha256 !==
		"e5edc4f987aa990e0219a6d79488b772a32be461ef7574a271631192b33d2269" ||
	provenance.bucketModuleSha256 !==
		"2286a3809e0d0f5a3ea8d58fee051b0a57d12c216f105bab453d469194a0bac2" ||
	provenance.backupModuleSha256 !==
		"aff55286a3c6c8b77750751cb9f4ea9c3b1b3649a6235f03d2d6154d3bf136d8"
)
	throw new Error("Reference modules differ from pinned Mailflare baseline");
type BuildOptions = {
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
const require = createRequire(join(source, "package.json"));
const { build } = z
	.object({
		build: z.custom<(options: BuildOptions) => Promise<unknown>>(
			(value) => typeof value === "function",
		),
	})
	.parse(require("esbuild"));
const node = Bun.which("node");
if (!node) throw new Error("Reference SQLite runtime requires Node");
const directory = await mkdtemp(join(source, ".mailrun-upload-capture-"));
try {
	const helper = `
import {writeFile,readFile,readdir,cp} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {hash} from 'bcryptjs';
import {SqliteDatabase} from 'original-database';
import {FileBucket} from 'original-bucket';
import {storeUpload,readUpload} from 'original-blobs';
import {exportDatabaseRecords,restoreDatabaseRecords} from 'original-backup';
const dir=process.argv[2],ref=process.argv[3],db=new SqliteDatabase(join(dir,'mailflare.sqlite'));
for(const name of (await readdir(ref+'/drizzle/migrations')).filter(x=>x.endsWith('.sql')).sort()) db.db.exec(await readFile(join(ref,'drizzle/migrations',name),'utf8'));
db.db.exec("INSERT INTO users(id,email,name,password_hash,role,is_primary_admin,created_at) VALUES('owner','owner@example.com','Owner','test-only','admin',1,1),('stranger','stranger@example.com','Stranger','test-only','user',0,1); INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('domain','owner','example.com','zone','active',1); INSERT INTO mailboxes(id,user_id,domain_id,local_part,created_at) VALUES('mailbox','owner','domain','hello',1),('stranger-mailbox','stranger','domain','private',1)");
db.db.prepare('UPDATE users SET password_hash=?').run(await hash('source-upload-fixture-password',4));
const bucket=new FileBucket(join(dir,'bucket')),expected=[];
let externalRequests=0; globalThis.fetch=async()=>{externalRequests++;throw new Error('External request forbidden in capture');};
const mime='From: hello@example.com\\r\\nTo: recipient@example.org\\r\\nSubject: Captured source upload\\r\\nMessage-ID: <captured-upload@example.com>\\r\\nMIME-Version: 1.0\\r\\nContent-Type: text/plain; charset=utf-8\\r\\n\\r\\nOriginal upload café\\r\\n';
for(const item of [{userId:'owner',content:mime,type:'message/rfc822',name:'Original café.eml'},{userId:'owner',content:'Original loose attachment',type:'text/plain',name:'loose.txt'},{userId:'stranger',content:'Private source upload',type:'application/octet-stream',name:null}]){
 const ctx={auth:{userId:item.userId},accountId:item.userId,env:{BUCKET:bucket}};
 const content=new TextEncoder().encode(item.content),uploaded=await storeUpload(ctx,content.buffer,item.type,item.name);
 const read=await readUpload(ctx,uploaded.blobId.slice(3));
 expected.push({...uploaded,userId:item.userId,name:read.name,sha256:createHash('sha256').update(new Uint8Array(read.content)).digest('hex')});
}
const multipart=await bucket.createMultipartUpload('drive/owner/pending',{httpMetadata:{contentType:'text/plain'}});
const part=await multipart.uploadPart(1,new TextEncoder().encode('abc').buffer);
const now=Math.floor(Date.now()/1000);
db.db.prepare("INSERT INTO drive_items(id,owner_id,kind,name,r2_key,size,content_type,upload_id,upload_part_size,upload_fingerprint,created_at,updated_at) VALUES('pending','owner','file','pending.txt','drive/owner/pending',3,'text/plain',?,67108864,'source-fingerprint',?,?)").run(multipart.uploadId,now,now);
db.db.prepare("INSERT INTO drive_upload_parts(item_id,part_number,etag) VALUES('pending',?,?)").run(part.partNumber,part.etag);
await bucket.put('avatars/source-preview.png','Original preview bytes',{httpMetadata:{contentType:'image/png'}});
const retainedText='Retained original body café',attachment=Buffer.from('Retained original attachment'),boundary='source-retention-boundary';
const retainedRaw='From: sender@example.org\\r\\nTo: hello@example.com\\r\\nSubject: Retained original Trash\\r\\nMessage-ID: <retained-trash@example.org>\\r\\nMIME-Version: 1.0\\r\\nContent-Type: multipart/mixed; boundary="'+boundary+'"\\r\\n\\r\\n--'+boundary+'\\r\\nContent-Type: text/plain; charset=utf-8\\r\\n\\r\\n'+retainedText+'\\r\\n--'+boundary+'\\r\\nContent-Type: text/plain\\r\\nContent-Disposition: attachment; filename="retained.txt"\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n'+attachment.toString('base64')+'\\r\\n--'+boundary+'--\\r\\n';
const unknownRaw='From: sender@example.org\\r\\nTo: hello@example.com\\r\\nSubject: Original unknown-age Spam\\r\\nMessage-ID: <retained-spam@example.org>\\r\\nContent-Type: text/plain; charset=utf-8\\r\\n\\r\\n'+retainedText+'\\r\\n';
await bucket.put('source-state/retained-trash.eml',retainedRaw,{httpMetadata:{contentType:'message/rfc822'}});
await bucket.put('source-state/retained-spam.eml',unknownRaw,{httpMetadata:{contentType:'message/rfc822'}});
await bucket.put('source-state/retained.txt',attachment,{httpMetadata:{contentType:'text/plain'}});
db.db.exec("UPDATE users SET trash_retention_days=30 WHERE id='owner'; INSERT INTO folders(id,user_id,mailbox_id,name,color,created_at) VALUES('historical-folder','owner','mailbox','Historical','#7c3aed',1); INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,text_body,raw_r2_key,status,created_at,folder_id,read,starred) VALUES('retained-trash','owner','mailbox','inbound','sender@example.org','hello@example.com','Retained original Trash','Retained original body café','source-state/retained-trash.eml','trash',1,'historical-folder',0,1),('retained-spam','owner','mailbox','inbound','sender@example.org','hello@example.com','Original unknown-age Spam','Retained original body café','source-state/retained-spam.eml','spam',2,NULL,1,0); UPDATE messages SET trashed_at=123 WHERE id='retained-trash'; UPDATE messages SET trashed_at=NULL WHERE id='retained-spam'");
db.db.prepare("INSERT INTO message_attachments(id,message_id,filename,content_type,size,r2_key,created_at) VALUES('retained-file','retained-trash','retained.txt','text/plain',?,'source-state/retained.txt',1)").run(attachment.length);

if(process.argv[4]){
 db.db.exec(await readFile(process.argv[4],'utf8'));
 db.db.prepare("UPDATE api_keys SET prefix=?,key_hash=? WHERE id='source-key'").run('ep_source_feature_key_only'.slice(0,12),await hash('ep_source_feature_key_only',4));
 db.db.prepare("UPDATE sessions SET token_hash=? WHERE id='source-session'").run(createHash('sha256').update('source-feature-session-only').digest('hex'));
 db.db.prepare("UPDATE mfa_recovery_codes SET code_hash=? WHERE id='source-recovery'").run(await hash('source-recovery-only',4));
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
 await bucket.put('source-state/feature-avatar.png',png,{httpMetadata:{contentType:'image/png'}});
 await bucket.put('source-state/feature-message.eml','From: Sender <sender@example.org>\\r\\nTo: hello@example.com\\r\\nSubject: Source Inbox café\\r\\nMessage-ID: <source-feature@example.org>\\r\\nList-Unsubscribe: <https://example.org/leave>\\r\\n\\r\\nSource inbox body café\\r\\n',{httpMetadata:{contentType:'message/rfc822'}});
 const attached=Buffer.from('Feature attachment café'),driveBytes=Buffer.from('Feature drive body café');
 await bucket.put('source-state/feature-attachment.txt',attached,{httpMetadata:{contentType:'text/plain'}});
 await bucket.put('source-state/feature-drive.txt',driveBytes,{httpMetadata:{contentType:'text/plain'}});
 db.db.prepare("UPDATE message_attachments SET size=? WHERE id='source-draft-file'").run(attached.length);
 db.db.prepare("UPDATE drive_items SET size=? WHERE id='source-drive-file'").run(driveBytes.length);

 const draft=db.db.prepare("SELECT * FROM messages WHERE id='source-draft'").get();
 const attachments=[{id:'source-draft-file',filename:'retained.txt',size:attached.length,digest:createHash('sha256').update(attached).digest('hex')}];
 const approvalPayload={from:draft.from_addr,to:draft.to_addr,cc:draft.cc_addr,bcc:draft.bcc_addr,subject:draft.subject??'',text:draft.text_body,html:draft.html_body,inReplyTo:draft.in_reply_to,references:draft.references_header,threadId:draft.thread_id,mailboxId:draft.mailbox_id,scheduledAt:new Date(4102444800000).toISOString(),attachments};
 db.db.prepare("UPDATE agent_send_approvals SET payload_hash=? WHERE id='source-approval'").run(createHash('sha256').update(JSON.stringify(approvalPayload)).digest('hex'));
 const history=await exportDatabaseRecords(db);
 await bucket.put('source-state/feature-backup.json',history,{httpMetadata:{contentType:'application/json'}});
 db.db.prepare("UPDATE backups SET size=? WHERE id='source-backup'").run(history.byteLength);
 if(db.db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Invalid source feature foreign keys');
}
await writeFile(join(dir,'backup.json'),await exportDatabaseRecords(db));
let restoredObjects;
if(process.argv.includes('--restore')){
 const restored=new SqliteDatabase(join(dir,'restore.sqlite'));
 for(const name of (await readdir(ref+'/drizzle/migrations')).filter(x=>x.endsWith('.sql')).sort())restored.db.exec(await readFile(join(ref,'drizzle/migrations',name),'utf8'));
 const records=await readFile(join(dir,'backup.json'));
 await restoreDatabaseRecords(restored,records.buffer.slice(records.byteOffset,records.byteOffset+records.byteLength));
 await cp(join(dir,'bucket'),join(dir,'restore-bucket'),{recursive:true});
 const restoredBucket=new FileBucket(join(dir,'restore-bucket')),uploads=[];
 for(const upload of expected){
  const read=await readUpload({auth:{userId:upload.userId},env:{BUCKET:restoredBucket}},upload.blobId.slice(3));
  if(!read)throw new Error('Original restore lost an uploaded object');
  uploads.push({blobId:upload.blobId,userId:upload.userId,type:read.type,name:read.name,sha256:createHash('sha256').update(new Uint8Array(read.content)).digest('hex')});
 }
 const item=restored.db.prepare("SELECT * FROM drive_items WHERE id='pending'").get();
 const parts=restored.db.prepare("SELECT part_number AS partNumber,etag FROM drive_upload_parts WHERE item_id='pending'").all();
 const complete=await restoredBucket.resumeMultipartUpload(item.r2_key,item.upload_id).complete(parts);
 const bytes=await complete.arrayBuffer();
 restoredObjects={uploads,drive:{id:item.id,size:bytes.byteLength,sha256:createHash('sha256').update(new Uint8Array(bytes)).digest('hex')}};
 restored.db.close();
}
await writeFile(join(dir,'expected.json'),JSON.stringify({uploads:expected,mime,drive:{id:'pending',uploadId:multipart.uploadId,part},externalRequests,...(restoredObjects?{restoredObjects}:{})}));
db.db.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
for(const name of (await readdir(ref+'/drizzle/migrations')).filter(name=>name.endsWith('.sql')).sort())db.db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(name);
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
			"original-database": join(source, "server/runtime/sqlite-database.ts"),
			"original-bucket": join(source, "server/runtime/file-bucket.ts"),
			"original-blobs": join(source, "src/lib/jmap/blobs.ts"),
			"original-backup": join(source, "src/lib/backups/export.ts"),
		},
		banner: {
			js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
		},
		define: { "process.env.MAILFLARE_RUNTIME": '"node"' },
		logLevel: "warning",
	});
	execFileSync(
		node,
		[
			bundle,
			directory,
			source,
			featureSeed ?? "",
			...(captureRestore ? ["--restore"] : []),
		],
		{
			stdio: "inherit",
			timeout: 30000,
		},
	);
	const backup: unknown = JSON.parse(
		await readFile(join(directory, "backup.json"), "utf8"),
	);
	const expected = z
		.object({
			uploads: z.array(
				z.object({
					accountId: z.string(),
					blobId: z.string(),
					userId: z.string(),
					type: z.string(),
					size: z.number(),
					name: z.string().nullable(),
					sha256: z.string(),
				}),
			),
			mime: z.string(),
			drive: z.object({
				id: z.string(),
				uploadId: z.string(),
				part: z.object({ partNumber: z.number(), etag: z.string() }),
			}),
			externalRequests: z.literal(0),
			restoredObjects: z
				.object({
					uploads: z.array(
						z.object({
							blobId: z.string(),
							userId: z.string(),
							type: z.string(),
							name: z.string().nullable(),
							sha256: z.string(),
						}),
					),
					drive: z.object({
						id: z.string(),
						size: z.number(),
						sha256: z.string(),
					}),
				})
				.optional(),
		})
		.parse(
			JSON.parse(await readFile(join(directory, "expected.json"), "utf8")),
		);
	const files: { key: string; base64: string; sha256: string }[] = [];
	for (const key of await readdir(join(directory, "bucket"), {
		recursive: true,
	})) {
		const path = join(directory, "bucket", key);
		if (!(await stat(path)).isFile()) continue;
		const bytes = await readFile(path);
		files.push({
			key: key.split("\\").join("/"),
			base64: bytes.toString("base64"),
			sha256: digest(bytes),
		});
	}
	files.sort((a, b) => a.key.localeCompare(b.key));

	const featureResponses: { path: string; status: number; body: unknown }[] =
		[];
	if (featureSeed) {
		await cp(join(directory, "bucket"), join(directory, "blobs"), {
			recursive: true,
		});
		const guard = join(directory, "network-guard.mjs");
		await writeFile(
			guard,
			"globalThis.fetch=async()=>{throw new Error('External request forbidden in feature capture')};",
		);
		const reservation = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: () => new Response(null),
			}),
			port = reservation.port;
		await reservation.stop(true);
		const child = Bun.spawn([node, "--import", guard, "dist/server.mjs"], {
			cwd: source,
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				TMPDIR: process.env.TMPDIR,
				NODE_ENV: "production",
				MAILFLARE_RUNTIME: "node",
				DATA_DIR: directory,
				HOST: "127.0.0.1",
				PORT: String(port),
				SMTP_INBOUND_PORT: "0",
				APP_URL: "http://127.0.0.1:" + port,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const errors = new Response(child.stderr).text(),
			output = new Response(child.stdout).text();
		try {
			const base = "http://127.0.0.1:" + port;
			let ready = false;
			for (let attempt = 0; attempt < 60; attempt++) {
				if (child.exitCode !== null)
					throw new Error("Original feature server exited");
				try {
					const r = await fetch(base + "/api/auth/me", {
						headers: { Authorization: "Bearer " + sourceFeatureSession },
						signal: AbortSignal.timeout(500),
					});
					const b = await r.json();
					if (
						r.ok &&
						z
							.object({ user: z.object({ id: z.literal("owner") }) })
							.safeParse(b).success
					) {
						ready = true;
						break;
					}
				} catch {}
				await Bun.sleep(100);
			}
			if (!ready)
				throw new Error("Original feature server did not become ready");
			for (const path of sourceFeatureRequests) {
				const response = await fetch(base + path, {
					headers: { Authorization: "Bearer " + sourceFeatureSession },
					signal: AbortSignal.timeout(10000),
				});
				if (!response.ok)
					throw new Error(
						`Original feature read failed: ${path} ${response.status}`,
					);
				featureResponses.push({
					path,
					status: response.status,
					body: await readFeatureBody(response),
				});
			}
		} finally {
			child.kill("SIGTERM");
			await child.exited;
			const stderr = await errors;
			await output;
			if (stderr) console.error(stderr);
		}
	}
	await writeFile(
		destination,
		JSON.stringify(
			{
				provenance,
				backup,
				expected,
				files,
				...(featureSeed ? { featureResponses } : {}),
			},
			null,
			2,
		) + "\n",
	);
	console.log(
		JSON.stringify({
			uploads: expected.uploads.length,
			files: files.length,
			multipartParts: 1,
			externalRequests: 0,
		}),
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
