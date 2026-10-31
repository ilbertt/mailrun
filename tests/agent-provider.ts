import { join } from "node:path";
import { readFile } from "node:fs/promises";
export async function startFixtureAgentProvider(
	directory: string,
	expectedKey = "fixture-agent-token",
) {
	const key = join(directory, "agent-provider-key.pem"),
		cert = join(directory, "agent-provider-cert.pem"),
		openssl = Bun.which("openssl");
	if (!openssl)
		throw new Error("OpenSSL is required for the local provider TLS fixture");
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
		throw new Error("Could not generate provider fixture certificate");
	const calls: { path: string; body: unknown }[] = [];
	const sse = (deltas: Record<string, unknown>[], finish = "stop") =>
		new Response(
			[
				...deltas.map((delta) => ({
					id: "fixture",
					object: "chat.completion.chunk",
					created: 1,
					model: "fixture-model",
					choices: [{ index: 0, delta, finish_reason: null }],
				})),
				{
					id: "fixture",
					object: "chat.completion.chunk",
					created: 1,
					model: "fixture-model",
					choices: [{ index: 0, delta: {}, finish_reason: finish }],
				},
				{
					id: "fixture",
					object: "chat.completion.chunk",
					created: 1,
					model: "fixture-model",
					choices: [],
					usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
				},
			]
				.map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n")
				.join("") + "data: [DONE]\n\n",
			{ headers: { "Content-Type": "text/event-stream" } },
		);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		tls: { key: await readFile(key), cert: await readFile(cert) },
		async fetch(request) {
			if (request.headers.get("Authorization") !== `Bearer ${expectedKey}`)
				return Response.json(
					{ error: { message: "Invalid fixture token" } },
					{ status: 401 },
				);
			const path = new URL(request.url).pathname;
			if (path === "/v1/models") {
				calls.push({ path, body: null });
				return Response.json({
					data: [
						{ id: "fixture-model", name: "Fixture model" },
						{ id: "second-model", name: "Second model" },
					],
				});
			}
			if (path !== "/v1/chat/completions")
				return new Response("Not found", { status: 404 });
			const body = (await request.json()) as {
				stream?: boolean;
				messages?: { role: string; content: unknown }[];
			};
			calls.push({ path, body });
			if (!body.stream)
				return Response.json({
					id: "fixture",
					object: "chat.completion",
					created: 1,
					model: "fixture-model",
					choices: [
						{
							index: 0,
							message: {
								role: "assistant",
								content: "Thank you for your email. Tuesday works for me.",
							},
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
				});
			const messages = body.messages ?? [],
				user = messages.filter((item) => item.role === "user").at(-1),
				text =
					typeof user?.content === "string"
						? user.content
						: JSON.stringify(user?.content ?? "");
			if (messages.some((item) => item.role === "tool"))
				return sse([
					{
						role: "assistant",
						content: "The requested result is ready for review.",
					},
				]);
			const name = /^draft/i.test(text)
					? "draft_reply"
					: /^mark.*read/i.test(text)
						? "mark_email_read"
						: "get_email",
				args =
					name === "draft_reply"
						? {
								emailId: "message",
								body: "Thank you for your email. Tuesday works for me.",
								replyAll: false,
							}
						: name === "mark_email_read"
							? { emailId: "message", read: true }
							: { emailId: "message" };
			return sse(
				[
					{ role: "assistant", content: "I will check the selected email." },
					{
						tool_calls: [
							{
								index: 0,
								id: "fixture-call",
								type: "function",
								function: { name, arguments: JSON.stringify(args) },
							},
						],
					},
				],
				"tool_calls",
			);
		},
	});
	return {
		url: `https://localhost:${server.port}/v1`,
		cert,
		calls,
		stop: () => server.stop(true),
	};
}
