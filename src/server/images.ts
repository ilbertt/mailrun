import { LocalStorage } from "./storage";
export async function imageResponse(request: Request, key: string) {
	const url = new URL(request.url),
		file = new LocalStorage().file(
			url.searchParams.get("variant") === "preview" ? key + ":preview" : key,
		);
	if (!(await file.exists())) return new Response("Not found", { status: 404 });
	const bytes = await file.arrayBuffer(),
		etag =
			'"' + new Bun.CryptoHasher("sha256").update(bytes).digest("hex") + '"';
	const headers = {
		"Content-Type": "image/webp",
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy": "default-src 'none'; img-src 'self'; sandbox",
		"Cache-Control": url.searchParams.has("v")
			? "private, max-age=31536000, immutable"
			: "private, no-cache",
		ETag: etag,
	};
	return new Response(
		request.headers.get("if-none-match") === etag ? null : bytes,
		{
			status: request.headers.get("if-none-match") === etag ? 304 : 200,
			headers,
		},
	);
}
function webp(bytes: Uint8Array) {
	return (
		bytes.length >= 12 &&
		new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
		new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
	);
}
export async function storeImages(
	form: FormData,
	key: string,
	save: (key: string) => Promise<unknown>,
) {
	const full = form.get("file"),
		preview = form.get("preview");
	if (
		!(full instanceof File) ||
		!(preview instanceof File) ||
		full.type !== "image/webp" ||
		preview.type !== "image/webp" ||
		full.size === 0 ||
		full.size > 1024 * 1024 ||
		preview.size === 0 ||
		preview.size > 32 * 1024
	)
		throw new Response("A resized WebP image and preview are required", {
			status: 400,
		});
	const [fullBytes, previewBytes] = await Promise.all([
		full.bytes(),
		preview.bytes(),
	]);
	if (!webp(fullBytes) || !webp(previewBytes))
		throw new Response("A valid WebP image and preview are required", {
			status: 400,
		});

	const storage = new LocalStorage();
	await storage.put(key + ":preview", previewBytes);
	await storage.put(key, fullBytes);
	await save(key);
	return Response.json({ ok: true });
}
