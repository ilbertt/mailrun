import { expect, test } from "bun:test";
import source from "./source-pages.json";

const canonical = (path: string) =>
	"/" +
	path
		.split("/")
		.filter(Boolean)
		.map((part) => (part.startsWith("[") || part.startsWith("$") ? "[]" : part))
		.join("/");

test("every pinned source page template has a native route, including legacy aliases", async () => {
	const generated = await Bun.file(
		new URL("../src/routeTree.gen.ts", import.meta.url),
	).text();
	const start = generated.indexOf("export interface FileRoutesByFullPath {");
	expect(start).toBeGreaterThan(0);
	const block = generated.slice(start, generated.indexOf("\n}", start));
	const paths = new Set(
		Array.from(block.matchAll(/^  '([^']+)':/gm), (match) =>
			canonical(match[1]!),
		),
	);
	expect(source.sourceRevision).toBe("71aa49b");
	expect(Object.keys(source.pages)).toHaveLength(72);
	expect(
		Object.keys(source.pages).filter((path) => !paths.has(canonical(path))),
	).toEqual([]);
	const nativePages = [...paths].filter(
		(path) =>
			!path.startsWith("/api/") &&
			!path.startsWith("/jmap") &&
			path !== "/mcp" &&
			!path.startsWith("/.well-known/"),
	);
	expect(nativePages.sort()).toEqual(
		[...new Set(Object.keys(source.pages).map(canonical))].sort(),
	);
});

test("the full-page composer retains the exact pinned page wrapper", async () => {
	const page = await Bun.file(
		new URL("../src/app/(dashboard)/compose/page.tsx", import.meta.url),
	).text();
	expect(new Bun.CryptoHasher("sha256").update(page).digest("hex")).toBe(
		source.pages["/compose"].sha256,
	);
});
