const generated = await Bun.file("src/queries.gen.ts").text();
const registry = generated.match(/export interface Queries \{([\s\S]*?)\n\}/)?.[1] ?? "";
const names = new Set([...registry.matchAll(/^\s+(\w+):/gm)].map(match => match[1]));
const missing: string[] = [];
let discovered = 0;
for await (const path of new Bun.Glob("src/server/**/*.ts").scan()) {
	for (const match of (await Bun.file(path).text()).matchAll(/\bsql\.(\w+)\s*`/g)) {
		discovered++;
		if (!names.has(match[1])) missing.push(`${path}: ${match[1]}`);
	}
}
if (!discovered || missing.length) throw new Error(`SQL generation coverage failed:\n${missing.join("\n")}`);
console.log(`SQL generation covers all ${discovered} named queries.`);
