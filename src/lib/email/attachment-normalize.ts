export function normalizeAttachmentContent(
	content: ArrayBuffer | Uint8Array | string,
	encoding?: "base64" | "utf8",
): ArrayBuffer {
	if (content instanceof ArrayBuffer) return content;
	if (content instanceof Uint8Array) return Uint8Array.from(content).buffer;
	if (encoding === "base64")
		return Uint8Array.from(atob(content), (character) =>
			character.charCodeAt(0),
		).buffer;
	return new TextEncoder().encode(content).buffer;
}
