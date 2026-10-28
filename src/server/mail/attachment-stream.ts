/** Encode local attachments incrementally, carrying at most two bytes between chunks. */
export async function* base64Blob(file: Blob) {
	const reader = file.stream().getReader();
	let carry = new Uint8Array(0);
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			const bytes = carry.length
					? Buffer.concat([carry, chunk.value])
					: Buffer.from(
							chunk.value.buffer,
							chunk.value.byteOffset,
							chunk.value.byteLength,
						),
				length = bytes.length - (bytes.length % 3);
			if (length) yield bytes.subarray(0, length).toString("base64");
			carry = Uint8Array.from(bytes.subarray(length));
		}
		if (carry.length) yield Buffer.from(carry).toString("base64");
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
export function iteratorStream(iterator: AsyncGenerator<Uint8Array>) {
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await iterator.next();
				if (next.done) controller.close();
				else controller.enqueue(next.value);
			} catch (error) {
				controller.error(error);
			}
		},
		async cancel() {
			await iterator.return(undefined);
		},
	});
}
