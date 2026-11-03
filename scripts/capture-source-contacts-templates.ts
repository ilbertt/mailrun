// Original HTTP handlers with genuine auth/DB/FileBucket and isolated mail/queue bindings.
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";
import {
	samples,
	prepare,
	requestFor,
	snapshot,
} from "../tests/contacts-templates-fixture";
import { hash } from "../src/server/auth/service";
const source = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Supply the pinned original checkout");
const directory = await mkdtemp(
		join(tmpdir(), "mailrun-test-source-contacts-"),
	),
	buildDirectory = await mkdtemp(join(source, ".mailrun-contacts-capture-"));
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
		`import {readFile,readdir,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {SqliteDatabase} from 'original-database';import {FileBucket} from 'original-bucket';import * as contacts from 'original-contacts';import {POST as block} from 'original-block';import * as templates from 'original-templates';import {DELETE as remove} from 'original-template-delete';const directory=process.argv[2],db=new SqliteDatabase(join(directory,'source.sqlite'));if(process.argv[3]==='init'){for(const name of (await readdir(process.argv[4]+'/drizzle/migrations')).filter(x=>x.endsWith('.sql')).sort())db.db.exec(await readFile(process.argv[4]+'/drizzle/migrations/'+name,'utf8'));db.db.close();}else{const spec=JSON.parse(await readFile(join(directory,'request.json'),'utf8'));let external=0;const avatars=[];globalThis.fetch=async(input)=>{const url=new URL(input instanceof Request?input.url:input);if(url.hostname==='www.gravatar.com'||url.hostname==='gravatar.com'){avatars.push(url.hostname);return new Response(null,{status:404});}external++;throw new Error('Unexpected external request');};globalThis.__captureEnv={DB:db,BUCKET:new FileBucket(join(directory,'blobs')),MAILFLARE_RUNTIME:'node'};const request=new Request(spec.url,{method:spec.method,headers:spec.headers,body:spec.bodyBase64?Buffer.from(spec.bodyBase64,'base64'):undefined});let response;try{const path=new URL(request.url).pathname;response=path==='/api/contacts/block'?await block(request):path==='/api/contacts'?await contacts[spec.method](request):path==='/api/templates'?await templates[spec.method](request):await remove(request,{params:Promise.resolve({id:path.split('/').at(-1)})});}catch(error){response=Response.json({error:error instanceof Error?error.message:'Source handler failed'},{status:500});}await writeFile(join(directory,'response.json'),JSON.stringify({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text(),external,avatars}));db.db.close();}`,
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
			"original-contacts": join(source, "src/app/api/contacts/route.ts"),
			"original-block": join(source, "src/app/api/contacts/block/route.ts"),
			"original-templates": join(source, "src/app/api/templates/route.ts"),
			"original-template-delete": join(
				source,
				"src/app/api/templates/[id]/route.ts",
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
	await prepare(db, directory, samples[0]!);
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
	for (const sample of samples) {
		await prepare(db, directory, sample);
		const request = requestFor(sample, "https://contacts-fixture.example", {
				Authorization: "Bearer " + tokens[sample.actor ?? "owner"],
			}),
			body = await request.bytes();
		await Bun.write(
			join(directory, "request.json"),
			JSON.stringify({
				method: sample.method,
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
				external: z.number(),
			})
			.parse(await Bun.file(join(directory, "response.json")).json());
		if (raw.external)
			throw new Error("Source attempted an external fetch: " + sample.name);
		cases.push({
			name: sample.name,
			snapshot: await snapshot(
				db,
				directory,
				new Response(raw.body, { status: raw.status, headers: raw.headers }),
				started,
			),
		});
	}
	const sourceHashes: Record<string, string> = {};
	for (const file of [
		"src/app/api/contacts/route.ts",
		"src/app/api/contacts/utils.ts",
		"src/app/api/contacts/block/route.ts",
		"src/lib/contacts/service.ts",
		"src/lib/profile/sync.ts",
		"src/lib/mailboxes/domain-addresses.ts",
		"src/app/api/templates/route.ts",
		"src/app/api/templates/[id]/route.ts",
		"src/app/api/drafts/utils.ts",
		"src/lib/email/sender.ts",
		"src/lib/email/message-cleanup.ts",
		"src/lib/auth/session.ts",
		"server/runtime/sqlite-database.ts",
		"server/runtime/file-bucket.ts",
	])
		sourceHashes[file] = new Bun.CryptoHasher("sha256")
			.update(await Bun.file(join(source, file)).bytes())
			.digest("hex");
	await Bun.write(
		"tests/source-contacts-templates-contracts.json",
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
			originalContactAndTemplateContracts: cases.length,
			externalRequests: 0,
		}),
	);
} finally {
	db?.close();
	await rm(directory, { recursive: true, force: true });
	await rm(buildDirectory, { recursive: true, force: true });
}
