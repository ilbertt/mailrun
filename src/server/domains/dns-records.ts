/** Compare TXT payloads after joining DNS presentation-format character strings.
 * Cloudflare splits long DKIM keys into quoted chunks in its DNS records API.
 * Preserve payload bytes: TXT keys are case-sensitive and may end in a dot.
 */
export function canonicalTxt(value: string): string {
	const quoted = value.trim();
	if (!/^(?:"(?:[^"\\]|\\[\s\S])*"\s*)+$/.test(quoted))
		return Buffer.from(value).toString("base64");
	const bytes: Buffer[] = [];
	for (const chunk of quoted.matchAll(/"((?:[^"\\]|\\[\s\S])*)"/g)) {
		const content = chunk[1] ?? "";
		let start = 0;
		for (const escape of content.matchAll(/\\(\d{3}|[\s\S])/g)) {
			bytes.push(Buffer.from(content.slice(start, escape.index)));
			const escaped = escape[1] ?? "";
			if (/^\d{3}$/.test(escaped)) {
				const byte = Number(escaped);
				if (byte > 255) return Buffer.from(value).toString("base64");
				bytes.push(Buffer.from([byte]));
			} else bytes.push(Buffer.from(escaped));
			start = escape.index + escape[0].length;
		}
		bytes.push(Buffer.from(content.slice(start)));
	}
	return Buffer.concat(bytes).toString("base64");
}
