/** The source reads URLSearchParams strings, including JSON-looking queries. */
export function parseRouteSearch(searchString: string): Record<string, string> {
	const search: Record<string, string> = {};
	for (const [key, value] of new URLSearchParams(searchString)) {
		// URLSearchParams.get selects the first occurrence. Define own properties
		// so names such as __proto__ cannot alter the object's prototype.
		if (!Object.hasOwn(search, key))
			Object.defineProperty(search, key, {
				value,
				enumerable: true,
				writable: true,
				configurable: true,
			});
	}
	return search;
}

export function stringifyRouteSearch(search: Record<string, unknown>): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(search))
		if (value !== undefined) params.append(key, String(value));
	const value = params.toString();
	return value ? `?${value}` : "";
}
