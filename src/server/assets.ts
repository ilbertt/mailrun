import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Adapted from bun-full-stack-starter: use Bun's embedded asset trees directly.
// This avoids encoding files into JavaScript and decoding them on each request.
function readFolder(name: "client" | "migrations", sourceDirectory: string): Map<string, Blob> {
	const files = new Map<string, Blob>();
	if (Bun.isStandaloneExecutable) {
		const prefix = `${name}/`;
		for (const file of Bun.embeddedFiles) {
			if ("name" in file && typeof file.name === "string" && file.name.startsWith(prefix)) {
				files.set(file.name.slice(prefix.length), file);
			}
		}
	} else if (existsSync(sourceDirectory)) {
		for (const path of new Bun.Glob("**/*").scanSync({ cwd: sourceDirectory, onlyFiles: true })) {
			const source = join(sourceDirectory, path);
			files.set(path, new Blob([readFileSync(source)], { type: Bun.file(source).type }));
		}
	}
	return new Map([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
export function getMigrations() {
	return readFolder("migrations", join(import.meta.dir, "../../drizzle/migrations"));
}
export function getAssetRoutes() {
	const routes: Record<string, Response> = {};
	for (const [path, file] of readFolder("client", join(import.meta.dir, "../../dist/client"))) {
		routes[`/${path}`] = new Response(file, { headers: {
			"Cache-Control": path.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
			"X-Content-Type-Options": "nosniff",
		} });
	}
	return routes;
}
