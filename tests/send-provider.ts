import { join } from "node:path";
import { readFile } from "node:fs/promises";
export async function startSendProvider(directory: string) {
	const key = join(directory, "send-key.pem"),
		cert = join(directory, "send-cert.pem"),
		openssl = Bun.which("openssl");
	if (!openssl) throw new Error("OpenSSL is required for isolated send checks");
	const built = Bun.spawnSync(
		[
			openssl,
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			key,
			"-out",
			cert,
			"-days",
			"1",
			"-subj",
			"/CN=localhost",
			"-addext",
			"subjectAltName=DNS:localhost,IP:127.0.0.1",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (built.exitCode)
		throw new Error("Could not create send fixture certificate");
	const deliveries: unknown[] = [];
	let fail = false;
	let failuresRemaining = Infinity;
	let beforeReply: (() => Promise<void>) | undefined;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		tls: { key: await readFile(key), cert: await readFile(cert) },
		async fetch(request) {
			const original = request.headers.get("X-Mailrun-Fixture-Url");
			if (
				!original ||
				new URL(original).hostname !== "api.cloudflare.com" ||
				!new URL(original).pathname.endsWith("/email/sending/send")
			)
				return new Response("Unexpected fixture target", { status: 400 });
			if (request.headers.get("Authorization") !== "Bearer synthetic-token")
				throw new Error("Unexpected synthetic credential");
			deliveries.push(await request.json());
			await beforeReply?.();
			return fail && failuresRemaining-- > 0
				? Response.json(
						{
							success: false,
							errors: [{ message: "Synthetic provider failure" }],
						},
						{ status: 500 },
					)
				: Response.json({
						success: true,
						result: { message_id: "<fixture-wire@example.net>" },
					});
		},
	});
	const preload = join(directory, "send-preload.mjs"),
		marker = join(directory, "send-network-fixture");
	await Bun.write(
		preload,
		`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'ready');const nativeFetch=globalThis.fetch;globalThis.fetch=Object.assign(async(input,init)=>{const request=input instanceof Request&&!init?input:new Request(input,init),url=new URL(request.url);if(url.hostname==='api.cloudflare.com'&&url.pathname.endsWith('/email/sending/send')){const headers=new Headers(request.headers);headers.set('X-Mailrun-Fixture-Url',request.url);return nativeFetch(${JSON.stringify(server.url.href)},{method:request.method,headers,body:request.body,duplex:'half',signal:request.signal});}if(url.hostname==='gravatar.com'||url.hostname.endsWith('.gravatar.com'))return new Response(null,{status:404});if(url.hostname==='127.0.0.1'||url.hostname==='localhost')return nativeFetch(input,init);throw new Error('Unexpected external send-fixture request');},{preconnect:nativeFetch.preconnect?.bind(nativeFetch)??(()=>{})});`,
	);
	// CLI rehearsals can advance logical delivery time without rewriting the
	// original scheduled payload. HTTP sessions otherwise keep the real clock.
	await Bun.write(
		preload,
		(await Bun.file(preload).text()) +
			`\nif(process.env.MAILRUN_FIXTURE_CLOCK!==undefined){const now=Number(process.env.MAILRUN_FIXTURE_CLOCK);if(!Number.isFinite(now))throw new Error('Invalid fixture clock');const RealDate=Date;globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};}`,
	);
	return {
		cert,
		preload,
		marker,
		deliveries,
		beforeReply(run?: () => Promise<void>) {
			beforeReply = run;
		},
		reset(value = false, maxFailures = Infinity) {
			deliveries.length = 0;
			fail = value;
			failuresRemaining = maxFailures;
			beforeReply = undefined;
		},
		stop: () => server.stop(true),
	};
}
