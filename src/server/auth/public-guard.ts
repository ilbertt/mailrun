import type { CloudflareFetch } from "../cloudflare/client";
import { z } from "zod";
declare global {
	var __mailrunPublicAuthAttempts:
		| Map<string, { count: number; until: number }>
		| undefined;
}
export async function publicAuthGuard(
	request: Request,
	token?: unknown,
	captcha = false,
	send: CloudflareFetch = fetch,
) {
	const attempts = (globalThis.__mailrunPublicAuthAttempts ??= new Map()),
		ip =
			request.headers.get("cf-connecting-ip")?.trim() ||
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
			"unknown",
		now = Date.now(),
		entry = attempts.get(ip);
	if (entry && entry.until > now && entry.count >= 20)
		throw new Response("Too many attempts. Try again shortly.", {
			status: 429,
			headers: { "Retry-After": "60" },
		});
	if (attempts.size >= 20000) {
		for (const [key, value] of attempts)
			if (value.until <= now) attempts.delete(key);
		if (attempts.size >= 20000) {
			const first = attempts.keys().next().value;
			if (first) attempts.delete(first);
		}
	}
	attempts.set(
		ip,
		entry && entry.until > now
			? { ...entry, count: entry.count + 1 }
			: { count: 1, until: now + 60000 },
	);
	const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
	if (!captcha || !secret) return;
	if (typeof token !== "string" || !token.trim() || token.length > 2048)
		throw new Response("Verification failed. Please try again.", {
			status: 400,
		});
	let valid = false;
	try {
		const response = await send(
			"https://challenges.cloudflare.com/turnstile/v0/siteverify",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					secret,
					response: token,
					remoteip: request.headers.get("cf-connecting-ip") ?? undefined,
					idempotency_key: crypto.randomUUID(),
				}),
				signal: AbortSignal.timeout(10000),
			},
		);
		const body = z
			.object({ success: z.boolean() })
			.safeParse(await response.json());
		valid = response.ok && body.success && body.data.success;
	} catch {}
	if (!valid)
		throw new Response("Verification failed. Please try again.", {
			status: 400,
		});
}
