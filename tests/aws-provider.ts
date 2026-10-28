import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { awsFixture } from "./aws-fixture";
export async function startFixtureAwsProvider(directory: string) {
	const key = join(directory, "aws-key.pem"),
		cert = join(directory, "aws-cert.pem"),
		openssl = Bun.which("openssl");
	if (!openssl)
		throw new Error("OpenSSL is required for the private AWS TLS fixture");
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
		throw new Error("Could not generate AWS fixture certificate");
	const provider = awsFixture();
	let applicationBase: string | undefined;
	provider.onSubscribe = async (endpoint, topicArn) => {
		if (!applicationBase) return;
		const source = new URL(endpoint),
			confirmation = new URL("https://sns.us-east-1.amazonaws.com/");
		confirmation.searchParams.set("Action", "ConfirmSubscription");
		confirmation.searchParams.set("TopicArn", topicArn);
		confirmation.searchParams.set("Token", "fixture-confirmation");
		const result = await fetch(
			applicationBase + source.pathname + source.search,
			{
				method: "POST",
				body: JSON.stringify({
					Type: "SubscriptionConfirmation",
					TopicArn: topicArn,
					SubscribeURL: confirmation.href,
				}),
			},
		);
		if (!result.ok)
			throw new Error(
				"SNS fixture confirmation failed: " + (await result.text()),
			);
		await result.body?.cancel();
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		maxRequestBodySize: 40 * 1024 * 1024,
		tls: { key: await readFile(key), cert: await readFile(cert) },
		async fetch(request) {
			const original = request.headers.get("x-mailrun-fixture-url");
			if (!original)
				return new Response("Missing fixture target", { status: 400 });
			const headers = new Headers(request.headers);
			headers.delete("x-mailrun-fixture-url");
			const signedHost = headers.get("x-mailrun-fixture-signed-host");
			headers.delete("x-mailrun-fixture-signed-host");
			if (signedHost !== null) headers.set("host", signedHost);
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
		setApplicationBase: (value: string) => {
			applicationBase = value;
		},
		stop: () => server.stop(true),
	};
}
export async function writeAwsFixturePreload(directory: string, url: string) {
	const marker = join(directory, "aws-fixture-loaded"),
		path = join(directory, "aws-preload.mjs");
	await Bun.write(
		path,
		`import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(marker)},'ready');
const nativeFetch=globalThis.fetch;
globalThis.fetch=Object.assign(async function(input,init){const request=input instanceof Request&&!init?input:new Request(input,init);const url=new URL(request.url);if(!url.hostname.endsWith('.amazonaws.com'))throw new Error('Unexpected external fetch in AWS smoke');const headers=new Headers(request.headers);headers.set('x-mailrun-fixture-url',request.url);headers.set('x-mailrun-fixture-signed-host',request.headers.get('host')||url.host);return nativeFetch(${JSON.stringify(url)},{method:request.method,headers,body:request.body,duplex:'half',redirect:'manual',signal:request.signal});},{preconnect:()=>{}});
`,
	);
	return { path, marker };
}
