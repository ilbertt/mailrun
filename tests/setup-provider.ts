import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { cloudflareFixture } from "./cloudflare-fixture";
const publicOrigin = "https://setup.fixture.example";
export async function startFixtureSetupProvider(
	directory: string,
	afterResponse?: (
		url: URL,
		request: Request,
		response: Response,
	) => Promise<void>,
) {
	const key = join(directory, "setup-key.pem"),
		cert = join(directory, "setup-cert.pem"),
		openssl = Bun.which("openssl");
	if (!openssl) throw new Error("OpenSSL is required for the setup fixture");
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
		throw new Error("Could not generate setup fixture certificate");
	const cf = cloudflareFixture(),
		calls: string[] = [];
	cf.access.accountId = "a".repeat(32);
	cf.access.apiToken = "test-cloudflare-token";
	cf.zones[0]!.account.id = cf.access.accountId;
	let appBase = "",
		healthy = true,
		workerName = "",
		relaySecret = "",
		uploads = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		tls: { key: await readFile(key), cert: await readFile(cert) },
		async fetch(request) {
			const dispatch = async () => {
				const original = request.headers.get("X-Mailrun-Fixture-Url");
				if (!original)
					return new Response("Missing fixture target", { status: 400 });
				const url = new URL(original),
					headers = new Headers(request.headers);
				headers.delete("X-Mailrun-Fixture-Url");
				calls.push(request.method + " " + url.hostname + url.pathname);
				if (
					url.origin === publicOrigin &&
					url.pathname === "/api/relay-health"
				) {
					if (!appBase)
						throw new Error("Setup fixture app address is not configured");
					return fetch(appBase + url.pathname, {
						method: request.method,
						headers,
						body: request.body,
					});
				}
				if (
					url.hostname.endsWith(".workers.dev") &&
					url.pathname === "/health"
				) {
					if (!healthy)
						return new Response("Fixture relay unavailable", { status: 503 });
					if (
						!relaySecret ||
						headers.get("Authorization") !== "Bearer " + relaySecret
					)
						throw new Error("Invalid relay health credential");
					const timestamp = String(Date.now()),
						signature = createHmac("sha256", relaySecret)
							.update(timestamp + "\n\n\n")
							.digest("hex");
					return fetch(appBase + "/api/relay-health", {
						method: "POST",
						headers: {
							"X-Mailrun-Timestamp": timestamp,
							"X-Mailrun-Signature": signature,
						},
					});
				}
				if (
					url.origin !== "https://api.cloudflare.com" ||
					headers.get("Authorization") !== "Bearer " + cf.access.apiToken
				)
					throw new Error("Unexpected setup provider request");
				if (url.pathname.endsWith("/workers/subdomain"))
					return Response.json({
						success: true,
						result: { subdomain: "fixture" },
					});
				const worker = /\/workers\/scripts\/([^/]+)(\/subdomain)?$/.exec(
					url.pathname,
				);
				if (worker) {
					if (request.method === "PUT") {
						const form = await request.formData(),
							metadata = z
								.object({
									bindings: z.array(
										z.object({ name: z.string(), text: z.string() }),
									),
								})
								.parse(JSON.parse(String(form.get("metadata"))));
						workerName = worker[1]!;
						relaySecret =
							metadata.bindings.find((row) => row.name === "RELAY_SECRET")
								?.text ?? "";
						if (
							metadata.bindings.find((row) => row.name === "MAILRUN_URL")
								?.text !== publicOrigin ||
							!relaySecret ||
							!(form.get("relay.js") instanceof File)
						)
							throw new Error("Invalid relay deployment metadata");
						uploads++;
					}
					return Response.json({ success: true, result: {} });
				}
				return cf.fetch(original, {
					method: request.method,
					headers,
					body: request.body,
				});
			};
			const response = await dispatch();
			const target = request.headers.get("X-Mailrun-Fixture-Url");
			if (target && afterResponse)
				await afterResponse(new URL(target), request, response);
			return response;
		},
	});
	return {
		cf,
		calls,
		cert,
		url: server.url.href,
		publicOrigin,
		get uploads() {
			return uploads;
		},
		get workerName() {
			return workerName;
		},
		setAppBase(value: string) {
			appBase = value;
		},
		setHealthy(value: boolean) {
			healthy = value;
		},
		stop: () => server.stop(true),
	};
}
export async function writeSetupFixturePreload(directory: string, url: string) {
	const path = join(directory, "setup-preload.mjs"),
		marker = join(directory, "setup-fixture-loaded");
	await Bun.write(
		path,
		`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'ready');
const nativeFetch=globalThis.fetch;globalThis.fetch=Object.assign(async function(input,init){
 const request=input instanceof Request&&!init?input:new Request(input,init),url=new URL(request.url);
 if(url.hostname==='gravatar.com'||url.hostname.endsWith('.gravatar.com'))return new Response(null,{status:404});
 if(url.origin!=='https://api.cloudflare.com'&&url.origin!==${JSON.stringify(publicOrigin)}&&!url.hostname.endsWith('.workers.dev'))throw new Error('Unexpected external fetch in setup fixture');
 const headers=new Headers(request.headers);headers.set('X-Mailrun-Fixture-Url',request.url);
 return nativeFetch(${JSON.stringify(url)},{method:request.method,headers,body:request.body,duplex:'half',redirect:'manual',signal:request.signal});
},{preconnect:()=>{}});`,
	);
	return { path, marker };
}
