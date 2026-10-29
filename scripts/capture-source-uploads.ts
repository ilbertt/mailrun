// Synthetic evidence from unmodified Mailflare. No external requests or email.
import {
	mkdtemp,
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

const source = resolve(z.string().min(1).parse(process.argv[2]));
const destination = resolve(z.string().min(1).parse(process.argv[3]));
const digest = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
const provenance = {
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
import {writeFile,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {hash} from 'bcryptjs';
import {SqliteDatabase} from 'original-database';
import {FileBucket} from 'original-bucket';
import {storeUpload,readUpload} from 'original-blobs';
import {exportDatabaseRecords} from 'original-backup';
const dir=process.argv[2],ref=process.argv[3],db=new SqliteDatabase(join(dir,'source.sqlite'));
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
await writeFile(join(dir,'backup.json'),await exportDatabaseRecords(db));
await writeFile(join(dir,'expected.json'),JSON.stringify({uploads:expected,mime,drive:{id:'pending',uploadId:multipart.uploadId,part},externalRequests}));
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
	execFileSync(node, [bundle, directory, source], {
		stdio: "inherit",
		timeout: 30000,
	});
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
	await writeFile(
		destination,
		JSON.stringify({ provenance, backup, expected, files }, null, 2) + "\n",
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
