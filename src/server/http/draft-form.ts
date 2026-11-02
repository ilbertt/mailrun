import { parseMultipartRequest } from "@remix-run/multipart-parser";

// Match the original draft handler's whole-request limit, including multipart
// headers. Count the stream as it is consumed instead of copying the full body
// before parsing it. The parser preserves MIME headers that Bun loses for some
// filenames (notably trailing whitespace combined with a NUL).
export async function readDraftAttachmentFiles(request: Request) {
	const limit = 30 * 1024 * 1024;
	let length = 0,
		tooLarge = Number(request.headers.get("Content-Length") ?? 0) > limit;
	if (tooLarge)
		throw new Response("Invalid attachment request", { status: 413 });
	try {
		const body = request.body?.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					length += chunk.length;
					if (length > limit) {
						tooLarge = true;
						throw new Error("Message too large");
					}
					controller.enqueue(chunk);
				},
			}),
		);
		const bounded = new Request(request.url, {
			method: "POST",
			headers: request.headers,
			body,
		});
		const files: File[] = [];
		for await (const part of parseMultipartRequest(bounded, {
			maxFileSize: limit,
			maxTotalSize: limit,
			maxHeaderSize: limit,
			maxParts: Number.MAX_SAFE_INTEGER,
		})) {
			if (part.name !== "attachments" || !part.isFile || part.size === 0)
				continue;
			// The original form parser retains literal backslashes in quoted names;
			// the multipart library treats them as quoted-pair escapes. Preserve the
			// original value for the storage layer's slash/backslash/NUL sanitizer.
			const filename =
				/(?:^|;)\s*filename="([^"]*)"/i.exec(
					part.headers["content-disposition"] ?? "",
				)?.[1] ??
				part.filename ??
				"attachment";
			files.push(
				new File([part.arrayBuffer], filename, {
					type: part.headers["content-type"] || "application/octet-stream",
				}),
			);
		}
		return files;
	} catch (error) {
		if (error instanceof Response) throw error;
		throw new Response("Invalid attachment request", {
			status: tooLarge ? 413 : 400,
		});
	}
}
