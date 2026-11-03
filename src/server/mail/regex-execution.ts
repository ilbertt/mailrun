import { fileURLToPath } from "node:url";
import { z } from "zod";

declare global {
	var __mailrunRegexEntrypoint: string | undefined;
	var __mailrunRegexQueue: Promise<void> | undefined;
}
export function configureRegexEntrypoint(entrypoint: string) {
	globalThis.__mailrunRegexEntrypoint = entrypoint;
}
export class RoutingRegexError extends Error {
	readonly code = "ROUTING_REGEX_LIMIT";
	constructor() {
		super(
			"Routing regular expression could not finish within its resource limit",
		);
		this.name = "RoutingRegexError";
	}
}
const syntaxCache = new Map<string, boolean>();
const resultCache = new Map<string, boolean>();
const maxCodeUnits = 40_000_000;

// The same executable has a narrow stdin-only mode. It never migrates data,
// registers cron or initializes HTTP/provider handlers. UTF-16 framing preserves
// JavaScript code units (including unpaired surrogates) without a full JSON copy
// of the message text in the parent process. Message text never enters argv.
export async function runRegexProcess() {
	const bytes = Buffer.from(await Bun.stdin.arrayBuffer()),
		line = bytes.indexOf(10);
	if (line < 0 || line > 16 * 1024) throw new RoutingRegexError();
	const header = z
		.object({
			pattern: z.string().max(8000),
			codeUnits: z.number().int().min(0).max(maxCodeUnits),
		})
		.parse(JSON.parse(bytes.subarray(0, line).toString("utf8")) as unknown);
	if (bytes.length - line - 1 !== header.codeUnits * 2)
		throw new RoutingRegexError();
	const value = bytes.subarray(line + 1).toString("utf16le");
	await Bun.write(Bun.stdout, "ready\n");
	let result = false;
	try {
		result = new RegExp(header.pattern, "i").test(value);
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
	}
	await Bun.write(Bun.stdout, JSON.stringify(result));
}

async function isolatedRegex(pattern: string, value: string) {
	if (value.length > maxCodeUnits) throw new RoutingRegexError();
	const previous = globalThis.__mailrunRegexQueue ?? Promise.resolve();
	let release: () => void = () => {};
	globalThis.__mailrunRegexQueue = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;
	try {
		const command = Bun.isStandaloneExecutable
			? [process.execPath, "regex-match"]
			: [
					process.execPath,
					"--smol",
					globalThis.__mailrunRegexEntrypoint ??
						fileURLToPath(new URL("../../../server/index.ts", import.meta.url)),
					"regex-match",
				];
		const child = Bun.spawn(command, {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "ignore",
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				TMPDIR: process.env.TMPDIR,
				NODE_ENV: "production",
				BUN_OPTIONS: "--no-env-file",
			},
			timeout: 2000,
			killSignal: "SIGKILL",
		});
		let computationTimer: ReturnType<typeof setTimeout> | undefined;
		const output = (async () => {
			let text = "";
			for await (const chunk of child.stdout) {
				text += new TextDecoder().decode(chunk);
				if (text.startsWith("ready\n") && !computationTimer)
					computationTimer = setTimeout(() => child.kill("SIGKILL"), 75);
			}
			return text;
		})();
		let inputFailed = false;
		try {
			child.stdin.write(
				JSON.stringify({ pattern, codeUnits: value.length }) + "\n",
			);
			await child.stdin.flush();
			for (let offset = 0; offset < value.length; offset += 32768) {
				child.stdin.write(
					Buffer.from(value.slice(offset, offset + 32768), "utf16le"),
				);
				await child.stdin.flush();
			}
			await child.stdin.end();
		} catch {
			inputFailed = true;
			child.kill("SIGKILL");
		}
		const code = await child.exited,
			body = await output;
		clearTimeout(computationTimer);
		if (inputFailed || code !== 0 || child.signalCode)
			throw new RoutingRegexError();
		try {
			if (!body.startsWith("ready\n")) throw new RoutingRegexError();
			return z.boolean().parse(JSON.parse(body.slice(6)) as unknown);
		} catch {
			throw new RoutingRegexError();
		}
	} finally {
		release();
	}
}
export async function routingRegexMatches(pattern: string, value: string) {
	let valid = syntaxCache.get(pattern);
	if (valid === undefined) {
		try {
			new RegExp(pattern, "i");
			valid = true;
		} catch {
			valid = false;
		}
		if (syntaxCache.size >= 128)
			syntaxCache.delete(syntaxCache.keys().next().value ?? "");
		syntaxCache.set(pattern, valid);
	}
	if (!valid) return false;
	const key =
		pattern.length + value.length <= 1024
			? JSON.stringify([pattern, value])
			: null;
	const cached = key ? resultCache.get(key) : undefined;
	if (cached !== undefined) return cached;
	const result = await isolatedRegex(pattern, value);
	if (key) {
		if (resultCache.size >= 128)
			resultCache.delete(resultCache.keys().next().value ?? "");
		resultCache.set(key, result);
	}
	return result;
}
