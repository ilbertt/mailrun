/** Older booking records store an empty host list and implicitly use their owner. */
export function parseBookingHostIds(value: string, ownerId: string): string[] {
	try {
		const parsed: unknown = JSON.parse(value);
		if (
			Array.isArray(parsed) &&
			parsed.length &&
			parsed.every(
				(id): id is string => typeof id === "string" && id.length > 0,
			) &&
			new Set(parsed).size === parsed.length
		)
			return [ownerId, ...parsed.filter((id) => id !== ownerId)];
	} catch {}
	return [ownerId];
}
