import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { resendFixture } from "./resend-fixture";
export async function startFixtureResendProvider(directory: string) {
	const key = join(directory, "resend-key.pem"),
		cert = join(directory, "resend-cert.pem"),
		openssl = Bun.which("openssl");
	if (!openssl)
		throw new Error("OpenSSL is required for the local Resend TLS fixture");
	const generated = Bun.spawnSync(
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
	if (generated.exitCode !== 0)
		throw new Error("Could not generate fixture certificate");
	const provider = resendFixture();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		maxRequestBodySize: 40 * 1024 * 1024,
		tls: { key: await readFile(key), cert: await readFile(cert) },
		async fetch(request) {
			const original = request.headers.get("x-mailrun-fixture-url");
			if (!original)
				return new Response("Missing fixture target", { status: 400 });
			const url = new URL(original),
				headers = new Headers(request.headers);
			headers.delete("x-mailrun-fixture-url");
			if (
				url.origin === "https://api.resend.com" &&
				headers.get("Authorization") !== "Bearer re_synthetic-fixture"
			)
				return new Response("Invalid fixture token", { status: 401 });
			return provider.send(original, {
				method: request.method,
				headers,
				body: request.body,
			});
		},
	});
	return {
		provider,
		cert,
		url: server.url.href,
		stop: () => server.stop(true),
	};
}
// Test-only network redirection runs before the compiled entrypoint. No fixture
// endpoint or configurable API root is added to the production application.
export async function writeResendFixturePreload(
	directory: string,
	url: string,
) {
	const marker = join(directory, "resend-fixture-loaded"),
		path = join(directory, "resend-preload.mjs");
	await Bun.write(
		path,
		`import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(marker)},'ready');
const nativeFetch=globalThis.fetch;
globalThis.fetch=Object.assign(async function(input,init){
 const request=input instanceof Request&&!init?input:new Request(input,init);
 const url=new URL(request.url);
 if(url.origin!=='https://api.resend.com'&&url.hostname!=='download.resend.example')throw new Error('Unexpected external fetch in Resend smoke');
 const headers=new Headers(request.headers);headers.set('x-mailrun-fixture-url',request.url);
 return nativeFetch(${JSON.stringify(url)},{method:request.method,headers,body:request.body,duplex:'half',redirect:'manual',signal:request.signal});
},{preconnect:()=>{}});
`,
	);
	return { path, marker };
}
