export async function readLimitedBody(
	request: Pick<Request, "headers" | "body">,
	limit: number,
) {
	if (Number(request.headers.get("content-length") ?? 0) > limit)
		throw new Error("Message too large");
	const chunks: Uint8Array[] = [];
	let length = 0;
	const reader = request.body?.getReader();
	if (reader) {
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				length += chunk.value.length;
				if (length > limit) {
					await reader.cancel();
					throw new Error("Message too large");
				}
				chunks.push(chunk.value);
			}
		} finally {
			reader.releaseLock();
		}
	}
	const bytes = new Uint8Array(length);
	let position = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, position);
		position += chunk.length;
	}
	return bytes;
}
