import PostalMime from "postal-mime";
export async function parseMail(raw: Uint8Array<ArrayBuffer>) {
	// PostalMime copies ArrayBufferView inputs. Our body reader already owns an
	// exact buffer; retain view bounds for callers that supply a partial view.
	const buffer =
		raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength
			? raw.buffer
			: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
	const parsed = await PostalMime.parse(buffer);
	if (raw.byteLength > 512 * 1024) Bun.gc(true);
	return parsed;
}
