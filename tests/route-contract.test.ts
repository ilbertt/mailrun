import { test, expect } from "bun:test";
import {
	sourceRouteContracts,
	matchSourceRoute,
	serveWithSourceContract,
} from "../src/server/http/route-contract";

function sample(path: string) {
	return path
		.replace(/\[\[\.\.\.[^\]]+\]\]/g, "session")
		.replace(/\[[^\]]+\]/g, "fixture");
}
test("the source inventory includes every route, hidden well-known path, aliases and re-exported methods", () => {
	expect(sourceRouteContracts).toHaveLength(165);
	for (const { path } of sourceRouteContracts)
		expect(matchSourceRoute(sample(path))?.path).toBe(path);
	expect(matchSourceRoute("/api/messages/counts")?.path).toBe(
		"/api/messages/counts",
	);
	expect(matchSourceRoute("/api/admin/agent")?.methods).toEqual(["GET", "PUT"]);
	expect(matchSourceRoute("/.well-known/jmap")?.methods).toEqual(["GET"]);
	expect(matchSourceRoute("/jmap")?.path).toBe("/jmap/[[...segments]]");
	expect(matchSourceRoute("/jmap/download/account/blob/name")?.path).toBe(
		"/jmap/[[...segments]]",
	);
	expect(matchSourceRoute("/api/messages/a/unrecognized")).toBeUndefined();
});

test("every original automatic OPTIONS response skips auth/body work and advertises exactly the source methods", async () => {
	for (const { path, methods } of sourceRouteContracts) {
		if (methods.includes("OPTIONS")) continue;
		const response = await serveWithSourceContract(
			new Request("https://mail.example" + sample(path), { method: "OPTIONS" }),
			() => {
				throw new Error("Automatic OPTIONS reached a handler");
			},
		);
		const allowed = [
			...methods,
			"OPTIONS",
			...(methods.includes("GET") && !methods.includes("HEAD") ? ["HEAD"] : []),
		]
			.sort()
			.join(", ");
		expect(response.status).toBe(204);
		expect(response.headers.get("Allow")).toBe(allowed);
		expect(response.body).toBeNull();
	}
});

test("every unsupported source method returns an empty 405 before invoking application handlers", async () => {
	for (const { path, methods } of sourceRouteContracts) {
		for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
			if (
				methods.includes(method) ||
				(method === "HEAD" && methods.includes("GET"))
			)
				continue;
			const response = await serveWithSourceContract(
				new Request("https://mail.example" + sample(path), {
					method,
					headers: { Origin: "https://foreign.example" },
				}),
				() => {
					throw new Error("Unsupported method reached auth/CSRF");
				},
			);
			expect(response.status).toBe(405);
			expect(response.body).toBeNull();
			expect(response.headers.get("Allow")).toBeNull();
		}
	}
});

test("HEAD delegates to GET with its original URL/auth/signal and cancels the body while preserving headers and status", async () => {
	const controller = new AbortController();
	const request = new Request(
		"https://mail.example/api/messages?mailboxId=private",
		{
			method: "HEAD",
			signal: controller.signal,
			headers: {
				Authorization: "Bearer synthetic-session",
				Cookie: "ep_session=synthetic-session",
			},
		},
	);
	let canceled = false;
	const response = await serveWithSourceContract(request, (current) => {
		expect(current.method).toBe("GET");
		expect(current.url).toBe(request.url);
		expect([...current.headers]).toEqual([...request.headers]);
		controller.abort();
		expect(current.signal.aborted).toBe(true);
		return new Response(
			new ReadableStream({
				cancel() {
					canceled = true;
				},
			}),
			{
				status: 206,
				headers: {
					"Content-Length": "128",
					"Content-Type": "message/rfc822",
					"Content-Range": "bytes 0-127/256",
					"Set-Cookie": "synthetic-refresh=true",
				},
			},
		);
	});
	expect(canceled).toBe(true);
	expect(response.body).toBeNull();
	expect(response.status).toBe(206);
	expect(response.headers.get("Content-Length")).toBe("128");
	expect(response.headers.get("Content-Range")).toBe("bytes 0-127/256");
	expect(response.headers.get("Set-Cookie")).toBe("synthetic-refresh=true");
});

test("explicit JMAP OPTIONS and native streaming HEAD handlers retain the actual request method", async () => {
	const options = new Request("https://mail.example/jmap/session", {
		method: "OPTIONS",
	});
	const response = await serveWithSourceContract(options, (current) => {
		expect(current).toBe(options);
		return new Response(null, {
			status: 204,
			headers: { "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS" },
		});
	});
	expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
		"GET, HEAD, POST, OPTIONS",
	);
	for (const path of [
		"/mcp",
		"/jmap/session",
		"/.well-known/jmap",
		"/api/export/messages",
	]) {
		const result = await serveWithSourceContract(
			new Request("https://mail.example" + path, { method: "HEAD" }),
			(current) => {
				expect(current.method).toBe("HEAD");
				return new Response(null, { headers: { "Content-Length": "9000" } });
			},
		);
		expect(result.body).toBeNull();
		expect(result.headers.get("Content-Length")).toBe("9000");
	}
});

test("source trailing-slash redirects preserve query strings; new native paths pass through unchanged", async () => {
	const response = await serveWithSourceContract(
		new Request("https://mail.example/api/messages/?mailboxId=private"),
		() => {
			throw new Error("Trailing slash reached handler");
		},
	);
	expect(response.status).toBe(308);
	expect(response.headers.get("Location")).toBe(
		"/api/messages?mailboxId=private",
	);
	expect(response.headers.get("Refresh")).toBe(
		"0;url=/api/messages?mailboxId=private",
	);
	expect(await response.text()).toBe("/api/messages?mailboxId=private");
	const request = new Request("https://mail.example/api/health");
	expect(
		await serveWithSourceContract(request, (current) => {
			expect(current).toBe(request);
			return new Response("native");
		}).then((r) => r.text()),
	).toBe("native");
});
