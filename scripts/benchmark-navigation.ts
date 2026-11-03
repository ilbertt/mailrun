import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { mkdir, copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { z } from "zod";
import { fixture } from "../tests/fixtures";
import { hash } from "../src/server/auth/service";
import {
	navigationEventSchema,
	type NavigationMetrics,
} from "./navigation-benchmark-schema";

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		reference: { type: "string" },
		before: { type: "string" },
		after: { type: "string" },
		output: { type: "string" },
		port: { type: "string" },
		delay: { type: "string" },
	},
});
const args = z
	.object({
		reference: z.string(),
		before: z.string(),
		after: z.string().default("dist/mailrun-local"),
		output: z.string().optional(),
		port: z.coerce.number().int().min(1024).max(65520).default(4320),
		delay: z.coerce.number().int().min(0).max(5000).default(100),
	})
	.parse(values);
const reference = resolve(args.reference),
	before = resolve(args.before),
	after = resolve(args.after);
if (!(await Bun.file(join(reference, ".next-node/BUILD_ID")).exists()))
	throw new Error("Build the original Node/Next app in production mode first");
for (const binary of [before, after])
	if (!(await Bun.file(binary).exists()))
		throw new Error("Missing host binary: " + binary);
const node = Bun.which("node");
if (!node) throw new Error("The original reference needs its Node runtime");
const output = args.output
	? resolve(args.output)
	: await mkdtemp(join(tmpdir(), "mailrun-navigation-results-"));
await mkdir(output, { recursive: true });
const clientBuild = await Bun.build({
	entrypoints: [join(import.meta.dir, "benchmark-navigation-client.ts")],
	target: "browser",
	format: "iife",
	minify: true,
});
if (!clientBuild.success || !clientBuild.outputs[0])
	throw new Error("Cannot build the local measurement client");
const client = await clientBuild.outputs[0].text();
type RequestMetric = NavigationMetrics["requests"][number];
type Flavor = "original" | "before" | "after";
const metrics: Record<Flavor, NavigationMetrics> = {
	original: { events: [], requests: [] },
	before: { events: [], requests: [] },
	after: { events: [], requests: [] },
};
const state = await fixture(),
	token = "synthetic-navigation-" + crypto.randomUUID();
const configurations: { name: Flavor; port: number; target: number }[] = [
	{ name: "original", port: args.port, target: args.port + 8 },
	{ name: "before", port: args.port + 1, target: args.port + 7 },
	{ name: "after", port: args.port + 2, target: args.port + 9 },
];
const children: ReturnType<typeof Bun.spawn>[] = [];
const proxies: ReturnType<typeof Bun.serve>[] = [];
let stopping = false;
async function stop() {
	if (stopping) return;
	stopping = true;
	for (const child of children) child.kill("SIGTERM");
	const timeout = setTimeout(() => {
		for (const child of children) child.kill("SIGKILL");
	}, 5000);
	try {
		await Promise.all(children.map((child) => child.exited));
		for (const proxy of proxies) await proxy.stop(true);
		for (const config of configurations)
			await Bun.write(
				join(output, config.name + "-browser-metrics.json"),
				JSON.stringify(metrics[config.name], null, 2),
			);
	} finally {
		clearTimeout(timeout);
		await state.close();
	}
}
try {
	state.db
		.query(
			"INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES('navigation-session','owner',?,?,1)",
		)
		.run(await hash(token), Math.floor(Date.now() / 1000) + 7200);
	state.db.exec(
		"UPDATE users SET email='hello@example.com' WHERE id='owner'; UPDATE domains SET routing_enabled=1",
	);
	const insert = state.db.query(
		"INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,snippet,text_body,status,created_at) VALUES(?,'owner','mailbox',?,'sender@example.org','hello@example.com',?,'Synthetic benchmark body','Synthetic benchmark body',?,?)",
	);
	state.db.transaction(() => {
		for (let i = 0; i < 10000; i++)
			insert.run(
				`bench-${i}`,
				"inbound",
				`Inbox benchmark ${i}`,
				"received",
				1700000000 + i,
			);
		for (let i = 0; i < 100; i++)
			insert.run(
				`sent-bench-${i}`,
				"outbound",
				`Sent benchmark ${i}`,
				"sent",
				1700100000 + i,
			);
	})();
	state.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	for (const config of configurations) {
		const probe = Bun.serve({
			hostname: "127.0.0.1",
			port: config.target,
			fetch: () => new Response(null, { status: 503 }),
		});
		await probe.stop(true);
		const directory = join(state.directory, config.name);
		await mkdir(directory);
		await copyFile(state.path, join(directory, "mailflare.sqlite"));
		let nav = 0,
			initialDocument = true,
			delayMs = args.delay;
		proxies.push(
			Bun.serve({
				hostname: "127.0.0.1",
				port: config.port,
				async fetch(request) {
					const url = new URL(request.url),
						stats = metrics[config.name];
					if (url.pathname === "/_benchmark/stats") return Response.json(stats);
					if (url.pathname === "/_benchmark/control") {
						const delay = z.coerce
							.number()
							.int()
							.min(0)
							.max(5000)
							.safeParse(url.searchParams.get("delay"));
						if (!delay.success)
							return new Response("Invalid delay", { status: 400 });
						delayMs = delay.data;
						return Response.json({ delayMs });
					}
					if (url.pathname === "/_benchmark/event") {
						const event = navigationEventSchema.safeParse(await request.json());
						if (!event.success)
							return new Response("Invalid measurement", { status: 400 });
						stats.events.push({ ...event.data, time: Date.now() });
						if (event.data.kind === "start") nav = event.data.id;
						return new Response(null, { status: 204 });
					}
					const headers = new Headers(request.headers);
					const firstDocument =
						initialDocument &&
						request.headers.get("accept")?.includes("text/html");
					const locale = firstDocument
						? "en"
						: request.headers
								.get("cookie")
								?.match(/(?:^|;\s*)mailflare-locale=([^;]*)/)?.[1];
					headers.set(
						"Cookie",
						"ep_session=" +
							token +
							(locale ? "; mailflare-locale=" + locale : ""),
					);
					headers.delete("Authorization");
					headers.set("Host", "127.0.0.1:" + config.target);
					const started = performance.now();
					if (url.pathname !== "/api/realtime") await Bun.sleep(delayMs);
					const response = await fetch(
						`http://127.0.0.1:${config.target}${url.pathname}${url.search}`,
						{
							method: request.method,
							headers,
							body: request.body,
							redirect: "manual",
						},
					);
					const outgoing = new Headers(response.headers);
					outgoing.delete("set-cookie");
					outgoing.delete("content-length");
					outgoing.delete("content-encoding");
					if (firstDocument) {
						initialDocument = false;
						outgoing.set(
							"Set-Cookie",
							"mailflare-locale=en; Path=/; SameSite=Lax",
						);
					}
					const metric: RequestMetric = {
						nav,
						path: url.pathname,
						method: request.method,
						status: response.status,
						headersMs: performance.now() - started,
						bytes: 0,
					};
					stats.requests.push(metric);
					if (!response.body)
						return new Response(null, {
							status: response.status,
							headers: outgoing,
						});
					if (response.headers.get("content-type")?.includes("text/html")) {
						const html = (await response.text()).replace(
							"</head>",
							`<script>${client}</script></head>`,
						);
						metric.bytes = Buffer.byteLength(html);
						return new Response(html, {
							status: response.status,
							headers: outgoing,
						});
					}
					const reader = response.body.getReader();
					return new Response(
						new ReadableStream({
							async pull(controller) {
								const { done, value } = await reader.read();
								if (done) {
									reader.releaseLock();
									controller.close();
									return;
								}
								metric.bytes += value.byteLength;
								controller.enqueue(value);
							},
							cancel() {
								return reader.cancel();
							},
						}),
						{ status: response.status, headers: outgoing },
					);
				},
			}),
		);
		const log = Bun.file(join(output, config.name + ".log"));
		children.push(
			Bun.spawn(
				config.name === "original"
					? [node, "dist/server.mjs"]
					: [config.name === "before" ? before : after],
				{
					cwd: config.name === "original" ? reference : directory,
					env: {
						PATH: process.env.PATH,
						HOME: process.env.HOME,
						TMPDIR: process.env.TMPDIR,
						NODE_ENV: "production",
						HOST: "127.0.0.1",
						DATA_DIR: directory,
						PORT: String(config.target),
						APP_URL: `http://127.0.0.1:${config.port}`,
						MAILFLARE_RUNTIME: "node",
						SMTP_INBOUND_PORT: "0",
					},
					stdout: log,
					stderr: log,
				},
			),
		);
	}
	await Promise.all(
		configurations.map(async (config) => {
			for (let attempt = 0; attempt < 40; attempt++) {
				if (children.some((child) => child.exitCode !== null))
					throw new Error(
						"A benchmark server exited during startup; inspect its log",
					);
				try {
					const response = await fetch(
						`http://127.0.0.1:${config.target}/api/auth/me`,
						{
							headers: { Cookie: "ep_session=" + token },
							signal: AbortSignal.timeout(500),
						},
					);
					if (
						response.ok &&
						z
							.object({ user: z.object({ id: z.literal("owner") }) })
							.safeParse(await response.json()).success
					)
						return;
				} catch {
					/* Startup may not be listening yet. */
				}
				await Bun.sleep(250);
			}
			throw new Error("Benchmark server did not become ready: " + config.name);
		}),
	);
	async function digestFile(path: string) {
		const hash = new Bun.CryptoHasher("sha256");
		for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
		return hash.digest("hex");
	}
	await Bun.write(
		join(output, "metadata.json"),
		JSON.stringify(
			{
				createdAt: new Date().toISOString(),
				messages: 10101,
				delayMs: args.delay,
				platform: `${process.platform}-${process.arch}`,
				bun: Bun.version,
				referenceVersion: z
					.object({ version: z.string() })
					.parse(await Bun.file(join(reference, "package.json")).json())
					.version,
				beforeSha256: await digestFile(before),
				afterSha256: await digestFile(after),
			},
			null,
			2,
		),
	);
	console.log(
		JSON.stringify(
			{
				output,
				messages: 10101,
				delayMs: args.delay,
				urls: configurations.map((config) => ({
					name: config.name,
					url: `http://127.0.0.1:${config.port}/inbox`,
				})),
			},
			null,
			2,
		),
	);
	process.on("SIGTERM", () => {
		void stop().then(() => process.exit());
	});
	process.on("SIGINT", () => {
		void stop().then(() => process.exit());
	});
	await new Promise(() => {});
} finally {
	await stop();
}
