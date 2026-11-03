// Exercise the pinned, unmodified source resolver through its original Node DB adapter.
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import {
	aliasRoutingCases,
	prepareAliasRoutingFixture,
} from "../tests/alias-contract-fixture";
const source = resolve(process.argv[2] ?? ""),
	root = resolve(process.argv[3] ?? "");
if (!basename(root).startsWith("mailrun-test-"))
	throw new Error("Use a disposable session fixture");
const dbPath = join(root, "original/mailflare.sqlite"),
	db = new Database(dbPath);
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
const directory = await mkdtemp(join(source, ".mailrun-alias-resolver-"));
try {
	const entry = join(directory, "capture.ts"),
		bundle = join(directory, "capture.mjs");
	await Bun.write(
		entry,
		`import {getDb} from 'original-db'; import {SqliteDatabase} from 'original-database'; import {resolveInboundAddress} from 'original-routing'; const raw=new SqliteDatabase(process.argv[2]); const value=await resolveInboundAddress(getDb({DB:raw}),process.argv[3],'sender@example.org'); console.log(JSON.stringify(value?{action:value.action,mailboxId:value.mailbox?.mailboxId??null}:null));raw.db.close();`,
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
	if (!node) throw new Error("Original SQLite adapter requires Node");
	const cases = [];
	for (const sample of aliasRoutingCases) {
		prepareAliasRoutingFixture(db, sample);
		const child = Bun.spawn([node, bundle, dbPath, sample.to], {
			stdout: "pipe",
			stderr: "pipe",
		});
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
		"server/runtime/sqlite-database.ts",
	])
		sourceHashes[file] = new Bun.CryptoHasher("sha256")
			.update(await Bun.file(join(source, file)).bytes())
			.digest("hex");
	await Bun.write(
		"tests/source-alias-routing.json",
		JSON.stringify(
			{ sourceRevision: "71aa49b", sourceHashes, cases },
			null,
			2,
		) + "\n",
	);
	console.log(JSON.stringify({ originalAliasRoutingCases: cases.length }));
} finally {
	db.close();
	await rm(directory, { recursive: true, force: true });
}
