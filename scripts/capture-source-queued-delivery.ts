// Original HTTP handlers with genuine auth/DB/FileBucket and isolated mail/queue bindings.
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";
import {
	queueSamples,
	prepareQueuedBase,
	queuedInput,
	queuedChanges,
	queuedSnapshot,
	QUEUED_AT,
	DUE_AT,
	DELIVER_AT,
	queueDeliveryTime,
} from "../tests/queued-delivery-fixture";
const source = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Supply the pinned original checkout");
const directory = await mkdtemp(join(tmpdir(), "mailrun-test-source-queue-")),
	buildDirectory = await mkdtemp(join(source, ".mailrun-queue-capture-"));
const require = createRequire(join(source, "package.json"));
type Build = (options: {
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
}) => Promise<unknown>;
const build = z
	.custom<Build>((v) => typeof v === "function")
	.parse(require("esbuild").build);
const node = Bun.which("node");
if (!node) throw new Error("Original SQLite adapter requires Node");
let db: Database | undefined;
try {
	const entry = join(buildDirectory, "capture.ts"),
		bundle = join(buildDirectory, "capture.mjs"),
		env = join(buildDirectory, "env.ts"),
		cookies = join(buildDirectory, "cookies.ts");
	await Bun.write(
		env,
		`export function getEnv(){return globalThis.__captureEnv;}export async function getEnvAsync(){return getEnv();}`,
	);
	await Bun.write(
		cookies,
		`export async function cookies(){throw new Error('This capture must use the original Bearer-session path');}`,
	);
	await Bun.write(
		entry,
		`import {readFile,readdir,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {createHash} from 'node:crypto';import {SqliteDatabase} from 'original-database';import {FileBucket} from 'original-bucket';import {sendEmail,processOutboundQueue} from 'original-send';import {exportDatabaseRecords} from 'original-backup';const directory=process.argv[2],db=new SqliteDatabase(join(directory,'source.sqlite'));if(process.argv[3]==='init'){for(const name of (await readdir(process.argv[4]+'/drizzle/migrations')).filter(x=>x.endsWith('.sql')).sort())db.db.exec(await readFile(process.argv[4]+'/drizzle/migrations/'+name,'utf8'));db.db.close();}else{const spec=JSON.parse(await readFile(join(directory,'request.json'),'utf8'));let now=spec.queuedAt;const RealDate=Date;globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};let external=0;const deliveries=[],events=[];globalThis.fetch=async(input)=>{const url=new URL(input instanceof Request?input.url:input);if(url.hostname==='gravatar.com')return new Response(null,{status:404});external++;throw new Error('Unexpected external request');};const bucket=new FileBucket(join(directory,'blobs'));const env={DB:db,BUCKET:bucket,MAILFLARE_RUNTIME:'node',APP_URL:'https://queue-fixture.example',OUTBOUND_QUEUE:{send:async(...args)=>events.push(args)},EMAIL:{send:async(message)=>{deliveries.push({...message,attachments:message.attachments?.map(file=>({...file,content:Buffer.from(file.content).toString('base64')}))});if(spec.failure)throw new Error('Synthetic provider failure');return {messageId:'<fixture-wire@example.net>'};}}};globalThis.__captureEnv=env;const attachments=spec.fileSize===undefined?[]:[{filename:'queued.txt',type:'text/plain',content:Buffer.alloc(spec.fileSize,81).buffer,disposition:spec.disposition,...(spec.contentId?{contentId:spec.contentId}:{})}];const submitted=await sendEmail(env,{...spec.input,attachments});const job=db.db.prepare('SELECT id FROM outbound_jobs WHERE message_id=?').get(submitted.messageId);const identity={messageId:submitted.messageId,jobId:job.id};const backup=JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(db)));const objects=[];async function inventory(folder,prefix=''){for(const entry of await readdir(folder,{withFileTypes:true})){const key=prefix+entry.name;if(entry.isDirectory())await inventory(join(folder,entry.name),key+'/');else if(!key.endsWith('.meta.json')){const bytes=await readFile(join(folder,entry.name)),object={key,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};if(bytes.length<=1024)object.base64=bytes.toString('base64');else{if(!bytes.equals(Buffer.alloc(bytes.length,81)))throw new Error('Nonfixture large object');object.fill=81;}objects.push(object);}}}await inventory(join(directory,'blobs'));const before={backup,identity,objects};now=spec.deliveryAt;for(const change of spec.changes){db.db.prepare(change.sql).run(...change.args.map(value=>value==='$message'?identity.messageId:value==='$job'?identity.jobId:value));}if(spec.variant==='missing-file'){for(const row of db.db.prepare('SELECT r2_key FROM message_attachments WHERE message_id=?').all(identity.messageId))await bucket.delete(row.r2_key);}let response;let sourceFailure=null;try{await processOutboundQueue(env,{kind:'email.scheduled',messageId:identity.messageId,jobId:identity.jobId,scheduledAt:new RealDate(spec.dueAt).toISOString()});response=Response.json({ok:true});}catch(error){sourceFailure={name:error?.name??null,message:error?.message??null,causeCode:error?.cause?.code??null};response=Response.json({error:error instanceof Error?error.message:'Source queue failed'},{status:500});}await writeFile(join(directory,'response.json'),JSON.stringify({status:response.status,body:await response.text(),deliveries,events,external,before,sourceFailure}));db.db.close();}`,
	);
	await build({
		entryPoints: [entry],
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
			"@/lib/cloudflare": env,
			"next/headers": cookies,
			"next/server": require.resolve("next/server.js"),
			"original-database": join(source, "server/runtime/sqlite-database.ts"),
			"original-bucket": join(source, "server/runtime/file-bucket.ts"),
			"original-send": join(source, "src/lib/email/send.ts"),
			"original-backup": join(source, "src/lib/backups/export.ts"),
		},
		banner: {
			js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);",
		},
		define: { "process.env.MAILFLARE_RUNTIME": '"node"' },
		logLevel: "warning",
	});
	const init = Bun.spawn([node, bundle, directory, "init", source], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const initErrors = await new Response(init.stderr).text();
	if (await init.exited) throw new Error(initErrors);
	db = new Database(join(directory, "source.sqlite"));
	db.exec("PRAGMA busy_timeout=5000");
	const cases = [];
	for (const sample of queueSamples) {
		await prepareQueuedBase(db, directory, sample);
		await Bun.write(
			join(directory, "request.json"),
			JSON.stringify({
				...sample,
				input: queuedInput(sample),
				queuedAt: QUEUED_AT,
				dueAt: DUE_AT + (sample.dueOffset ?? 0),
				deliveryAt: queueDeliveryTime(sample),
				changes: queuedChanges(sample, {
					messageId: "$message",
					jobId: "$job",
				}),
			}),
		);
		const child = Bun.spawn([node, bundle, directory, "case"], {
			stdout: "pipe",
			stderr: "pipe",
			timeout: 30000,
			killSignal: "SIGKILL",
		});
		const errors = await new Response(child.stderr).text();
		if (await child.exited) throw new Error(sample.name + ": " + errors);
		const raw = z
			.object({
				status: z.number(),
				body: z.string(),
				deliveries: z.array(z.unknown()),
				events: z.array(z.unknown()),
				external: z.number(),
				sourceFailure: z
					.object({
						name: z.string().nullable(),
						message: z.string().nullable(),
						causeCode: z.string().nullable(),
					})
					.nullable()
					.optional(),
				before: z
					.object({
						identity: z.object({ messageId: z.string(), jobId: z.string() }),
					})
					.passthrough(),
			})
			.parse(await Bun.file(join(directory, "response.json")).json());
		if (raw.external) throw new Error("Unexpected source queue fetch");
		cases.push({
			name: sample.name,
			before: raw.before,
			queueEvents: raw.events.length,
			sourceFailure: raw.sourceFailure
				? {
						...raw.sourceFailure,
						message: raw.sourceFailure.message
							?.replace(/aud_[A-Za-z0-9_-]+/g, "$generated-audit")
							.replaceAll(raw.before.identity.messageId, "$message"),
					}
				: null,
			snapshot: await queuedSnapshot(
				db,
				directory,
				new Response(raw.body, {
					status: raw.status,
					headers: { "Content-Type": "application/json" },
				}),
				raw.deliveries,
				raw.before.identity,
			),
		});
	}

	const sourceHashes: Record<string, string> = {};
	for (const file of [
		"src/lib/email/send.ts",
		"src/lib/email/sender.ts",
		"src/lib/email/outbound-provider.ts",
		"src/lib/email/attachments.ts",
		"src/lib/email/cloud-attachment-utils.ts",
		"src/lib/email/shared-attachments.ts",
		"src/lib/mailboxes/audit.ts",
		"src/lib/backups/export.ts",
		"src/lib/contacts/service.ts",
		"src/lib/mailboxes/access.ts",
		"server/runtime/sqlite-database.ts",
		"server/runtime/file-bucket.ts",
	])
		sourceHashes[file] = new Bun.CryptoHasher("sha256")
			.update(await Bun.file(join(source, file)).bytes())
			.digest("hex");
	await Bun.write(
		"tests/source-queued-delivery-contracts.json",
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
		JSON.stringify({
			originalQueuedDeliveryContracts: cases.length,
			externalRequests: 0,
		}),
	);
} finally {
	db?.close();
	await rm(directory, { recursive: true, force: true });
	await rm(buildDirectory, { recursive: true, force: true });
}
