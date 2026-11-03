import { join } from "node:path";
import { readFile } from "node:fs/promises";
export const fixtureAvatarPng = Uint8Array.from(
	Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
		"base64",
	),
);
export async function startFixtureAvatarProvider(directory: string) {
	const key = join(directory, "avatar-key.pem"),
		cert = join(directory, "avatar-cert.pem"),
		openssl = Bun.which("openssl");
	if (!openssl)
		throw new Error("OpenSSL is required for the avatar HTTPS fixture");
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
		throw new Error("Could not generate avatar fixture certificate");
	const calls: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		tls: { key: await readFile(key), cert: await readFile(cert) },
		fetch(request) {
			const original = request.headers.get("x-mailrun-fixture-url");
			if (!original || new URL(original).hostname !== "gravatar.com")
				return new Response(null, { status: 400 });
			if (request.headers.has("Authorization") || request.headers.has("Cookie"))
				throw new Error("Application credentials leaked to avatar provider");
			calls.push(original);
			return new Response(fixtureAvatarPng, {
				headers: { "Content-Type": "image/png" },
			});
		},
	});
	return { cert, url: server.url.href, calls, stop: () => server.stop(true) };
}
export async function writeAvatarFixturePreload(
	directory: string,
	url?: string,
) {
	const path = join(directory, "avatar-preload.mjs"),
		marker = join(directory, "avatar-fixture-loaded");
	await Bun.write(
		path,
		`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'ready');const nativeFetch=globalThis.fetch;globalThis.fetch=Object.assign(async function(input,init){const request=input instanceof Request&&!init?input:new Request(input,init);const original=new URL(request.url);if(original.hostname==='gravatar.com'||original.hostname.endsWith('.gravatar.com')){${url ? `const headers=new Headers(request.headers);headers.set('x-mailrun-fixture-url',request.url);return nativeFetch(${JSON.stringify(url)},{method:request.method,headers,body:request.body,duplex:'half',signal:request.signal,redirect:'manual'});` : `return new Response(null,{status:404});`}}return nativeFetch(input,init);},{preconnect:nativeFetch.preconnect?.bind(nativeFetch)??(()=>{})});`,
	);
	return { path, marker };
}
