import { mkdir } from "node:fs/promises";

await mkdir("src/generated", { recursive: true });
if (await Bun.file("relay/index.ts").exists()) {
	const result = await Bun.build({ entrypoints: ["relay/index.ts"], target: "browser", minify: true });
	if (!result.success || !result.outputs[0]) throw new Error("Relay compilation failed");
	const source = await result.outputs[0].text();
	await Bun.write("src/generated/relay.ts", `export const relaySource = ${JSON.stringify(source)};\nexport const relayVersion = ${JSON.stringify(Bun.hash(source).toString(16))};\n`);
}
