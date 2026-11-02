// Original HTTP handlers with genuine auth/DB/FileBucket and isolated mail/queue bindings.
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";
import {
	sendSamples,
	prepareSendFixture,
	sendRequest,
	sendSnapshot,
} from "../tests/send-contract-fixture";
import { hash } from "../src/server/auth/service";
const source = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Supply the pinned original checkout");
const directory = await mkdtemp(join(tmpdir(), "mailrun-test-source-send-")),
	buildDirectory = await mkdtemp(join(source, ".mailrun-send-capture-"));
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
		`import {readFile,readdir,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {SqliteDatabase} from 'original-database';import {FileBucket} from 'original-bucket';import {POST as send} from 'original-send-handler';import {POST as cancel} from 'original-cancel-handler';const directory=process.argv[2],db=new SqliteDatabase(join(directory,'source.sqlite'));if(process.argv[3]==='init'){for(const name of (await readdir(process.argv[4]+'/drizzle/migrations')).filter(x=>x.endsWith('.sql')).sort())db.db.exec(await readFile(process.argv[4]+'/drizzle/migrations/'+name,'utf8'));db.db.close();}else{const spec=JSON.parse(await readFile(join(directory,'request.json'),'utf8'));const deliveries=[],queue=[];let external=0;globalThis.fetch=async()=>{external++;throw new Error('Unexpected external request');};globalThis.__captureEnv={DB:db,BUCKET:new FileBucket(join(directory,'blobs')),MAILFLARE_RUNTIME:'node',EMAIL:{send:async(message)=>{deliveries.push({...message,attachments:message.attachments?.map(file=>({...file,content:Buffer.from(file.content).toString('base64')}))});if(spec.providerFailure)throw new Error('Synthetic provider failure');return {messageId:'<fixture-wire@example.net>'};}},OUTBOUND_QUEUE:{send:async(...args)=>queue.push(args)}};const request=new Request(spec.url,{method:'POST',headers:spec.headers,body:spec.bodyBase64?Buffer.from(spec.bodyBase64,'base64'):undefined});let response;try{response=spec.kind==='cancel'?await cancel(request,{params:Promise.resolve({messageId:spec.id})}):await send(request);}catch(error){response=Response.json({error:error instanceof Error?error.message:'Source handler failed'},{status:500});}await writeFile(join(directory,'response.json'),JSON.stringify({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text(),deliveries,queue,external}));db.db.close();}`,
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
			"next/server":require.resolve('next/server.js'),
			"original-database": join(source, "server/runtime/sqlite-database.ts"),
			"original-bucket": join(source, "server/runtime/file-bucket.ts"),
			"original-send-handler": join(source, "src/app/api/send/route.ts"),
			"original-cancel-handler": join(
				source,
				"src/app/api/messages/[messageId]/cancel-schedule/route.ts",
			),
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
	const tokens = {
		owner: "synthetic-send-owner",
		stranger: "synthetic-send-stranger",
	};
	await prepareSendFixture(db, directory, sendSamples[0]!);
	for (const [actor, token] of Object.entries(tokens))
		db.query(
			"INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,1)",
		).run(
			"send-" + actor,
			actor,
			await hash(token),
			Math.floor(Date.now() / 1000) + 7200,
		);
	const cases = [];
	for (const sample of sendSamples) {
		await prepareSendFixture(db, directory, sample);
		const request = sendRequest(sample, "https://send-fixture.example", {
				Authorization: "Bearer " + tokens[sample.actor ?? "owner"],
			}),
			body = await request.bytes();
		await Bun.write(
			join(directory, "request.json"),
			JSON.stringify({
				kind: sample.kind,
				id: sample.id ?? "scheduled",
				providerFailure: sample.variant === "provider-failure",
				url: request.url,
				headers: Object.fromEntries(request.headers),
				bodyBase64: Buffer.from(body).toString("base64"),
			}),
		);
		const started = Math.floor(Date.now() / 1000);
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
				headers: z.record(z.string(), z.string()),
				body: z.string(),
				deliveries: z.array(z.unknown()),
				queue: z.array(z.unknown()),
				external: z.number(),
			})
			.parse(await Bun.file(join(directory, "response.json")).json());
		if (raw.external)
			throw new Error("Source attempted an external fetch: " + sample.name);
		cases.push({
			name: sample.name,
			snapshot: await sendSnapshot(
				db,
				directory,
				new Response(raw.body, { status: raw.status, headers: raw.headers }),
				started,
				raw.deliveries,
			),
		});
	}
	const sourceHashes: Record<string, string> = {};
	for (const file of [
		"src/app/api/send/route.ts",
		"src/app/api/send/utils.ts",
		"src/app/api/send/error-utils.ts",
		"src/app/api/messages/[messageId]/cancel-schedule/route.ts",
		"src/lib/email/send.ts",
		"src/lib/email/scheduled.ts",
		"src/lib/email/sender.ts",
		"src/lib/email/attachments.ts",
		"src/lib/email/outbound-provider.ts",
		"src/lib/validators.ts",
		"src/lib/auth/cookies.ts",
		"src/lib/auth/session.ts",
		"server/runtime/sqlite-database.ts",
		"server/runtime/file-bucket.ts",
	])
		sourceHashes[file] = new Bun.CryptoHasher("sha256")
			.update(await Bun.file(join(source, file)).bytes())
			.digest("hex");
	await Bun.write(
		"tests/source-send-contracts.json",
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
			originalSendAndCancellationContracts: cases.length,
			externalRequests: 0,
		}),
	);
} finally {
	db?.close();
	await rm(directory, { recursive: true, force: true });
	await rm(buildDirectory, { recursive: true, force: true });
}
