/** Read the RFC 5322 header block without loading MIME bodies or attachments. */
export async function readMailHeaderBlock(file: Blob) {
	const reader = file.stream().getReader(),
		chunks: Uint8Array[] = [];
	let size = 0,
		tail = new Uint8Array(0);
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const search = new Uint8Array(tail.length + value.length);
			search.set(tail);
			search.set(value, tail.length);
			let end = -1;
			for (let i = 0; i < search.length; i++) {
				if (
					(search[i] === 10 && search[i + 1] === 10) ||
					(search[i] === 13 && search[i + 1] === 13)
				) {
					end = i + 2;
					break;
				}
				if (
					search[i] === 13 &&
					search[i + 1] === 10 &&
					search[i + 2] === 13 &&
					search[i + 3] === 10
				) {
					end = i + 4;
					break;
				}
			}
			const keep = end < 0 ? value.length : end - tail.length;
			chunks.push(value.subarray(0, keep));
			size += keep;
			if (end >= 0) {
				await reader.cancel();
				break;
			}
			tail = search.slice(-3);
		}
	} finally {
		reader.releaseLock();
	}
	const headers = new Uint8Array(size + 4);
	let offset = 0;
	for (const chunk of chunks) {
		headers.set(chunk, offset);
		offset += chunk.length;
	}
	headers.set([13, 10, 13, 10], size);
	return headers;
}
