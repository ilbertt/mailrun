const result = await Bun.build({
	entrypoints: ["server/index.ts"],
	target: "bun",
	compile: {
		...(process.env.BUILD_TARGET === "host" ? { outfile: "dist/mailrun-local" } : { target: "bun-linux-x64" as const, outfile: "dist/mailrun" }),
		assets: ["dist/client", "drizzle/migrations"],
	},
	bytecode: true,
	format: "esm",
	naming: { asset: "[dir]/[name].[ext]" },
	minify: { whitespace: true, syntax: true },
	define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
console.log(`Built ${result.outputs.map(file => file.path).join(", ")}`);
