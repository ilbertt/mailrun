// Match the original AGENT_RATE_LIMIT binding: 120 requests per 60 seconds.
// The HTTP process owns these transient counters; cron never serves requests.
const windows = new Map<string, { start: number; count: number }>();
export function allowAgentRequest(key: string, now = Date.now()) {
	if (windows.size > 1000)
		for (const [id, entry] of windows)
			if (now - entry.start >= 60000) windows.delete(id);
	const current = windows.get(key);
	if (!current || now - current.start >= 60000) {
		windows.set(key, { start: now, count: 1 });
		return true;
	}
	if (current.count >= 120) return false;
	current.count++;
	return true;
}
