import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { z } from "zod";
const source = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Supply the pinned original checkout");
const require = createRequire(join(source, "package.json"));
const build = z
	.custom<(value: Record<string, unknown>) => Promise<unknown>>(
		(value) => typeof value === "function",
	)
	.parse(require("esbuild").build);
const directory = await mkdtemp(join(source, ".mailrun-identifier-capture-"));
const sourcePrefixes = new Set<string>();
const prefixWriters: Record<string, string[]> = {};
for await (const path of new Bun.Glob("**/*.ts").scan({
	cwd: join(source, "src"),
})) {
	const text = await Bun.file(join(source, "src", path)).text();
	for (const match of text.matchAll(/newId\(["']([^"']+)["']\)/g)) {
		const prefix = match[1]!;
		sourcePrefixes.add(prefix);
		const paths = prefixWriters[prefix] ?? [];
		if (!paths.includes(path)) paths.push(path);
		prefixWriters[prefix] = paths;
	}
}
const prefixes = [...sourcePrefixes].sort();
try {
	const entry = join(directory, "entry.ts"),
		bundle = join(directory, "entry.mjs");
	await Bun.write(
		entry,
		`import {newId}from'original-ids';import{generateApiKey,verifyApiKey}from'original-api-keys';import{generateSessionToken,hashSessionToken}from'original-session';import{identifierShape}from'identifier-shape';const prefixes=${JSON.stringify(prefixes)},key=generateApiKey(),session=generateSessionToken();console.log(JSON.stringify({bare:identifierShape(newId(),null),emptyPrefix:identifierShape(newId(''),null),prefixed:prefixes.map(prefix=>({input:prefix,shape:identifierShape(newId(prefix),prefix)})),apiKey:{shape:identifierShape(key.fullKey),prefixLength:key.prefix.length,prefixMatches:key.prefix===key.fullKey.slice(0,12),bcryptCost:Number(key.hash.split('$')[2]),verifies:verifyApiKey(key.fullKey,key.hash)},session:{shape:identifierShape(session),hashLength:(await hashSessionToken(session)).length,sampleHash:await hashSessionToken("sess_source_identifier_fixture")}}));`,
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
			"original-ids": join(source, "src/lib/ids.ts"),
			"original-api-keys": join(source, "src/lib/api-keys.ts"),
			"original-session": join(source, "src/lib/auth/session.ts"),
			"identifier-shape": resolve("tests/identifier-shape.ts"),
		},
		banner: {
			js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);",
		},
		define: { "process.env.MAILFLARE_RUNTIME": '"node"' },
		logLevel: "warning",
	});
	const node = Bun.which("node");
	if (!node) throw new Error("Node required for original factories");
	const child = Bun.spawn([node, bundle], {
		stdout: "pipe",
		stderr: "pipe",
		timeout: 30000,
	});
	const [out, err] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (await child.exited)
		throw new Error("Original identifier capture failed: " + err);
	const result: unknown = JSON.parse(out);
	const sourceHashes: Record<string, string> = {};
	for (const path of [
		"src/lib/ids.ts",
		"src/lib/api-keys.ts",
		"src/lib/auth/session.ts",
		"src/lib/auth/login-challenge.ts",
		"src/lib/auth/password-reset.ts",
		"src/lib/mailboxes/audit.ts",
		"src/app/api/folders/route.ts",
		"src/app/api/auth/register/route.ts",
		"package-lock.json",
	])
		sourceHashes[path] = new Bun.CryptoHasher("sha256")
			.update(await Bun.file(join(source, path)).bytes())
			.digest("hex");
	await Bun.write(
		"tests/source-identifiers-contracts.json",
		JSON.stringify(
			{
				sourceRevision: "71aa49b",
				sourceVersion: "0.5.2",
				sourceHashes,
				nanoidVersion: require("nanoid/package.json").version,
				prefixWriters: Object.fromEntries(
					Object.entries(prefixWriters)
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([prefix, paths]) => [prefix, paths.sort()]),
				),
				result,
			},
			null,
			2,
		) + "\n",
	);
	console.log(
		JSON.stringify({
			sourcePrefixClasses: prefixes.length,
			originalFactories: true,
			secretValuesCaptured: false,
		}),
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
