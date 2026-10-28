import type { CloudflareFetch } from "../cloudflare/client";
import { readLimitedBody } from "../http/body";
import { LocalStorage } from "../storage";
import { imageContentType } from "../images";
const allowed = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
async function image(
	url: URL,
	limit: number,
	send: CloudflareFetch,
	signal?: AbortSignal,
) {
	for (let redirects = 0; redirects < 4; redirects++) {
		const response = await send(url, {
			redirect: "manual",
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(5000)])
				: AbortSignal.timeout(5000),
		});
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("Location");
			await response.body?.cancel();
			if (!location) return null;
			const next = new URL(location, url);
			if (
				next.protocol !== "https:" ||
				next.username ||
				next.password ||
				!(
					next.hostname === "gravatar.com" ||
					next.hostname.endsWith(".gravatar.com")
				)
			)
				return null;
			url = next;
			continue;
		}
		const type = response.headers
			.get("Content-Type")
			?.split(";")[0]
			?.trim()
			.toLowerCase();
		if (
			!response.ok ||
			!type ||
			!allowed.has(type) ||
			Number(response.headers.get("Content-Length")) > limit
		) {
			await response.body?.cancel();
			return null;
		}
		const bytes = await readLimitedBody(response, limit);
		return imageContentType(bytes) === type ? bytes : null;
	}
	return null;
}
export async function fetchGravatar(
	userId: string,
	email: string,
	owner: string,
	send: CloudflareFetch = fetch,
	signal?: AbortSignal,
) {
	let key: string | undefined;
	const storage = new LocalStorage();
	try {
		const normalized = email.trim().toLowerCase(),
			hash = new Bun.CryptoHasher("sha256").update(normalized).digest("hex");
		const full = await image(
			new URL(`https://gravatar.com/avatar/${hash}?d=404&r=g&s=256`),
			2 * 1024 * 1024,
			send,
			signal,
		);
		if (!full) return null;
		key = `contact-avatars/${userId}/${encodeURIComponent(normalized)}/${owner}`;
		await storage.put(key, full);
		try {
			const preview = await image(
				new URL(`https://gravatar.com/avatar/${hash}?d=404&r=g&s=16`),
				32 * 1024,
				send,
				signal,
			);
			if (preview) await storage.put(key + ":preview", preview);
		} catch (error) {
			if (signal?.aborted) throw error;
		}
		return key;
	} catch (error) {
		if (key)
			await Promise.all([
				storage.delete(key),
				storage.delete(key + ":preview"),
			]);
		if (signal?.aborted) throw error;
		return null;
	}
}
