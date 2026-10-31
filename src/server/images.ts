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
		"Content-Type":
			imageContentType(new Uint8Array(bytes)) ?? "application/octet-stream",
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
export function imageContentType(bytes: Uint8Array) {
	if (
		bytes.length >= 12 &&
		new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
		new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP"
	)
		return "image/webp";
	if (
		bytes.length >= 8 &&
		[137, 80, 78, 71, 13, 10, 26, 10].every(
			(value, index) => bytes[index] === value,
		)
	)
		return "image/png";
	if (
		bytes.length >= 3 &&
		bytes[0] === 255 &&
		bytes[1] === 216 &&
		bytes[2] === 255
	)
		return "image/jpeg";
	if (
		bytes.length >= 6 &&
		/^GIF8[79]a$/.test(new TextDecoder().decode(bytes.subarray(0, 6)))
	)
		return "image/gif";
	return null;
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
	if (
		imageContentType(fullBytes) !== "image/webp" ||
		imageContentType(previewBytes) !== "image/webp"
	)
		throw new Response("A valid WebP image and preview are required", {
			status: 400,
		});

	const storage = new LocalStorage();
	await storage.put(key + ":preview", previewBytes);
	await storage.put(key, fullBytes);
	await save(key);
	return Response.json({ ok: true });
}
