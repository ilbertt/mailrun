/** Compare random values by their observable namespace, length and alphabet. */
export function identifierShape(value: string, prefix?: string | null) {
	const namespace =
		prefix === undefined ? (value.match(/^([^_]+)_/)?.[1] ?? null) : prefix;
	const suffix = namespace === null ? value : value.slice(namespace.length + 1);
	return {
		prefix: namespace,
		suffixLength: suffix.length,
		urlSafe: /^[A-Za-z0-9_-]+$/.test(suffix),
	};
}
