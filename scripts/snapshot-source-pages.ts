import { resolve, relative, dirname } from "node:path";

const checkout = process.argv[2],
	revision = process.argv[3];
if (!checkout || revision !== "71aa49b")
	throw new Error(
		"Usage: bun scripts/snapshot-source-pages.ts <original-checkout-or-archive> 71aa49b",
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
const pages: Record<
	string,
	{ file: string; sha256: string; redirectTo?: string }
> = {};
for await (const path of new Bun.Glob("**/page.tsx").scan({
	cwd: app,
	absolute: true,
	dot: true,
})) {
	const text = await Bun.file(path).text();
	const url =
		"/" +
		relative(app, dirname(path))
			.split("/")
			.filter((part) => !part.startsWith("("))
			.join("/");
	if (pages[url]) throw new Error(`Duplicate source page: ${url}`);
	// All unconditional aliases in this pinned baseline use this complete,
	// single-statement function body. Conditional auth redirects are excluded.
	const redirectTo =
		/export default function\s+\w+\(\)\s*\{\s*redirect\((['"])([^'"]+)\1\);\s*\}/.exec(
			text,
		)?.[2];
	pages[url] = {
		file: relative(root, path),
		sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
		...(redirectTo ? { redirectTo } : {}),
	};
}
await Bun.write(
	"tests/source-pages.json",
	JSON.stringify(
		{
			sourceRevision: revision,
			sourceVersion: "0.5.2",
			pages: Object.fromEntries(
				Object.entries(pages).sort(([a], [b]) => a.localeCompare(b)),
			),
		},
		null,
		2,
	) + "\n",
);
console.log(
	`Captured ${Object.keys(pages).length} original page templates and ${Object.values(pages).filter((page) => page.redirectTo).length} unconditional redirects.`,
);
