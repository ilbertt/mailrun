import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import {
	engineSamples,
	prepareRuleEngineFixture,
	engineInput,
	engineRule,
} from "../tests/rule-engine-fixture";
const source = resolve(process.argv[2] ?? ""),
	root = resolve(process.argv[3] ?? "");
if (!basename(root).startsWith("mailrun-test-"))
	throw new Error("Use a disposable session fixture");
const dbPath = join(root, "original/mailflare.sqlite"),
	db = new Database(dbPath);
db.exec("PRAGMA busy_timeout=5000");
if (
	(
		db.query("SELECT email FROM users WHERE id='owner'").get() as {
			email: string;
		}
	).email !== "hello@example.com"
)
	throw new Error("Not the synthetic fixture");
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
const directory = await mkdtemp(join(source, ".mailrun-rule-engine-"));
try {
	const entry = join(directory, "capture.ts"),
		bundle = join(directory, "capture.mjs");
	await Bun.write(
		entry,
		`import {getDb} from 'original-db';import {SqliteDatabase} from 'original-database';import {resolveInboundAddress,resolveInboxRuleDestination,matchesRule} from 'original-routing';const raw=new SqliteDatabase(process.argv[2]);const db=getDb({DB:raw});const spec=JSON.parse(process.argv[3]);const input={toAddress:spec.input.to,fromAddress:spec.input.from,subject:spec.input.subject,content:spec.input.content};let value;if(spec.kind==='match'){const r=spec.rule;value=matchesRule({pattern:r.pattern,matchField:r.match_field,matchOperator:r.match_operator,matchValue:r.match_value},input);}else if(spec.kind==='inbox')value=await resolveInboxRuleDestination(db,{...input,mailboxId:'mailbox'});else{const r=await resolveInboundAddress(db,input.toAddress,input.fromAddress);value=r?{action:r.action,mailboxId:r.mailbox?.mailboxId??null,forwardTo:r.forwardTo??null,keepCopy:r.keepCopy??null,reason:r.rejectReason??null}:null;}console.log(JSON.stringify(value));raw.db.close();`,
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
			"original-db": join(source, "src/db/index.ts"),
			"original-database": join(source, "server/runtime/sqlite-database.ts"),
			"original-routing": join(source, "src/lib/email/routing.ts"),
		},
		banner: {
			js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);",
		},
		define: { "process.env.MAILFLARE_RUNTIME": '"node"' },
		logLevel: "warning",
	});
	const node = Bun.which("node");
	if (!node) throw new Error("Original adapter requires Node");
	const cases = [];
	for (const sample of engineSamples) {
		prepareRuleEngineFixture(db, sample);
		const child = Bun.spawn(
			[
				node,
				bundle,
				dbPath,
				JSON.stringify({
					kind: sample.kind,
					input: engineInput(sample),
					rule: engineRule(sample),
				}),
			],
			{ stdout: "pipe", stderr: "pipe", timeout: 10000, killSignal: "SIGKILL" },
		);
		const [out, errors] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (await child.exited) throw new Error(errors);
		cases.push({ name: sample.name, result: JSON.parse(out) as unknown });
	}
	const sourceHashes: Record<string, string> = {};
	for (const file of [
		"src/lib/email/routing.ts",
		"src/lib/email/recipient-address.ts",
		"src/lib/mailboxes/domain-addresses.ts",
		"src/lib/email/address.ts",
		"server/runtime/sqlite-database.ts",
	])
		sourceHashes[file] = new Bun.CryptoHasher("sha256")
			.update(await Bun.file(join(source, file)).bytes())
			.digest("hex");
	await Bun.write(
		"tests/source-rule-engine.json",
		JSON.stringify(
			{ sourceRevision: "71aa49b", sourceHashes, cases },
			null,
			2,
		) + "\n",
	);
	console.log(JSON.stringify({ originalRuleEngineCases: cases.length }));
} finally {
	db.close();
	await rm(directory, { recursive: true, force: true });
}
