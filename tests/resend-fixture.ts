import { z } from "zod";
import type { CloudflareFetch } from "../src/server/cloudflare/client";
import type { ResendDomain, ResendRecord } from "../src/server/resend/client";
export function resendFixture() {
	const domains = new Map<string, ResendDomain>(),
		hooks = new Map<
			string,
			{ id: string; endpoint: string; events: string[] }
		>(),
		calls: { method: string; url: string; headers: Headers; body: unknown }[] =
			[];
	let mode: "full" | "restricted" | "invalid" | "unreachable" = "full",
		sequence = 0;
	let onRequest: ((request: Request) => void | Promise<void>) | undefined;
	let raw = new TextEncoder().encode(
		"From: Sender <sender@example.net>\r\nTo: Hello <hello@example.com>\r\nSubject: Resend received\r\nMessage-ID: <received@example.net>\r\n\r\nA provider message.",
	);
	let received = {
		id: "received",
		from: "Sender <sender@example.net>",
		to: ["hello@example.com"],
		cc: [] as string[],
		bcc: [] as string[],
		raw: {
			download_url:
				"https://download.resend.example/raw.eml?Signature=private-fixture-signature",
		},
	};
	let rawLength: number | undefined,
		rawError = false,
		sendStatus = 200;
	function records(value: ResendDomain) {
		const rows: ResendRecord[] = [];
		if (value.capabilities?.sending === "enabled")
			rows.push(
				{
					record: "DKIM",
					type: "TXT",
					name: "resend._domainkey",
					value: "p=fixture-key",
					status: value.status,
				},
				{
					record: "SPF",
					type: "MX",
					name: "send",
					value: "feedback-smtp.us-east-1.amazonses.com",
					priority: 10,
					status: value.status,
				},
				{
					record: "SPF",
					type: "TXT",
					name: "send",
					value: "v=spf1 include:amazonses.com ~all",
					status: value.status,
				},
			);
		if (value.capabilities?.receiving === "enabled")
			rows.push({
				record: "Receiving",
				type: "MX",
				name: "@",
				value: "inbound-smtp.us-east-1.amazonaws.com",
				priority: 10,
				status: value.status,
			});
		return rows;
	}
	function current(id: string) {
		const value = domains.get(id);
		return value ? { ...value, records: records(value) } : null;
	}
	function addDomain(name = "example.com", sending = true, receiving = false) {
		const value: ResendDomain = {
			id: "resend-" + ++sequence,
			name,
			status: "pending",
			capabilities: {
				sending: sending ? "enabled" : "disabled",
				receiving: receiving ? "enabled" : "disabled",
			},
		};
		domains.set(value.id, value);
		return value;
	}
	const send: CloudflareFetch = async (input, init) => {
		const request =
				input instanceof Request && !init ? input : new Request(input, init),
			url = new URL(request.url);
		if (onRequest) await onRequest(request);
		if (url.hostname === "download.resend.example") {
			if (request.headers.has("Authorization"))
				throw new Error("API key leaked to download URL");
			if (rawError) throw new Error("Failed to fetch " + url.href);
			calls.push({
				method: request.method,
				url: url.href,
				headers: request.headers,
				body: null,
			});
			return new Response(raw, {
				headers:
					rawLength === undefined
						? {}
						: { "Content-Length": String(rawLength) },
			});
		}
		if (url.origin !== "https://api.resend.com")
			throw new Error("Unexpected external request " + url.origin);
		if (mode === "unreachable") throw new Error("Fixture unavailable");
		const body: unknown = request.body ? await request.json() : null;
		calls.push({
			method: request.method,
			url: url.href,
			headers: request.headers,
			body,
		});
		if (mode === "invalid")
			return Response.json(
				{ name: "validation_error", message: "Invalid API key" },
				{ status: 401 },
			);
		if (mode === "restricted" && url.pathname !== "/emails")
			return Response.json(
				{ name: "restricted_api_key", message: "Restricted key" },
				{ status: 401 },
			);
		if (url.pathname === "/domains") {
			if (request.method === "GET")
				return Response.json({ data: [...domains.values()] });
			if (request.method === "POST") {
				const input = z
					.object({
						name: z.string(),
						capabilities: z.object({
							sending: z.enum(["enabled", "disabled"]),
							receiving: z.enum(["enabled", "disabled"]),
						}),
					})
					.parse(body);
				return Response.json(
					addDomain(
						input.name,
						input.capabilities.sending === "enabled",
						input.capabilities.receiving === "enabled",
					),
				);
			}
		}
		const match = /^\/domains\/([^/]+)(\/verify)?$/.exec(url.pathname);
		if (match) {
			const id = decodeURIComponent(match[1]!),
				value = domains.get(id);
			if (!value)
				return Response.json({ message: "Not found" }, { status: 404 });
			if (match[2]) {
				value.status = "verified";
				return Response.json({ id });
			}
			if (request.method === "GET") return Response.json(current(id));
			if (request.method === "DELETE") {
				domains.delete(id);
				return Response.json({ id });
			}
			if (request.method === "PATCH") {
				const input = z
					.object({
						capabilities: z.object({
							sending: z.enum(["enabled", "disabled"]).optional(),
							receiving: z.enum(["enabled", "disabled"]).optional(),
						}),
					})
					.parse(body);
				value.capabilities = { ...value.capabilities, ...input.capabilities };
				return Response.json({ id });
			}
		}
		if (url.pathname === "/webhooks") {
			if (request.method === "GET")
				return Response.json({ data: [...hooks.values()] });
			if (request.method === "POST") {
				const input = z
						.object({ endpoint: z.string(), events: z.array(z.string()) })
						.parse(body),
					id = "hook-" + ++sequence;
				hooks.set(id, { id, ...input });
				return Response.json({
					id,
					signing_secret:
						"whsec_" +
						Buffer.from("synthetic-webhook-secret").toString("base64"),
				});
			}
		}
		if (url.pathname.startsWith("/webhooks/") && request.method === "DELETE") {
			hooks.delete(decodeURIComponent(url.pathname.slice("/webhooks/".length)));
			return Response.json({ deleted: true });
		}
		if (url.pathname === "/emails/receiving/received")
			return Response.json(received);
		if (url.pathname === "/emails" && request.method === "POST")
			return sendStatus === 200
				? Response.json({ id: "provider-email" })
				: Response.json(
						{ message: "Synthetic send failure" },
						{ status: sendStatus },
					);
		throw new Error(
			"Unhandled fixture path " + request.method + " " + url.pathname,
		);
	};
	return {
		send,
		domains,
		hooks,
		calls,
		addDomain,
		get mode() {
			return mode;
		},
		set mode(value: typeof mode) {
			mode = value;
		},
		get onRequest() {
			return onRequest;
		},
		set onRequest(value: typeof onRequest) {
			onRequest = value;
		},
		get raw() {
			return raw;
		},
		set raw(value: typeof raw) {
			raw = value;
		},
		get received() {
			return received;
		},
		set received(value: typeof received) {
			received = value;
		},
		get rawLength() {
			return rawLength;
		},
		set rawLength(value: typeof rawLength) {
			rawLength = value;
		},
		set rawError(value: boolean) {
			rawError = value;
		},
		set sendStatus(value: number) {
			sendStatus = value;
		},
	};
}
