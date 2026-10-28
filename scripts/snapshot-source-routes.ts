import { resolve, relative, dirname } from "node:path";

// This baseline's routes use named function/const exports or named re-exports.
// Keep the snapshot in the repository; ordinary builds need no source checkout.
const checkout = process.argv[2],
	revision = process.argv[3];
if (!checkout || revision !== "71aa49b")
	throw new Error(
		"Usage: bun scripts/snapshot-source-routes.ts <original-checkout-or-archive> 71aa49b",
	);
const root = resolve(checkout),
	app = resolve(root, "src/app");
const metadata: unknown = await Bun.file(resolve(root, "package.json")).json();
if (
	!metadata ||
	typeof metadata !== "object" ||
	!("version" in metadata) ||
	metadata.version !== "0.5.2"
)
	throw new Error("Source must be the recorded Mailflare 0.5.2 baseline");
const supported = new Set([
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
]);
const routes: Record<string, string[]> = {};
for await (const path of new Bun.Glob("**/route.ts").scan({
	cwd: app,
	absolute: true,
	dot: true,
})) {
	const text = await Bun.file(path).text();
	const methods = new Set<string>();
	for (const match of text.matchAll(
		/\bexport\s+(?:(?:async\s+)?function|const)\s+(\w+)/g,
	))
		if (match[1] && supported.has(match[1])) methods.add(match[1]);
	for (const match of text.matchAll(/\bexport\s*\{([^}]+)\}/g))
		for (const specifier of (match[1] ?? "").split(",")) {
			const name = specifier
				.trim()
				.split(/\s+as\s+/)
				.at(-1);
			if (name && supported.has(name)) methods.add(name);
		}
	if (!methods.size) throw new Error(`No HTTP exports found: ${path}`);
	const url =
		"/" +
		relative(app, dirname(path))
			.split("/")
			.filter((part) => !part.startsWith("("))
			.join("/");
	if (routes[url]) throw new Error(`Duplicate source route: ${url}`);
	routes[url] = [...methods].sort();
}
await Bun.write(
	"src/server/http/source-routes.json",
	JSON.stringify(
		{
			sourceRevision: revision,
			sourceVersion: "0.5.2",
			routes: Object.fromEntries(
				Object.entries(routes).sort(([a], [b]) => a.localeCompare(b)),
			),
		},
		null,
		2,
	) + "\n",
);
console.log(
	`Captured ${Object.keys(routes).length} original HTTP route contracts.`,
);
