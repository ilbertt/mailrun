import { normalizeMessageId } from "./thread-lookup";
export { normalizeMessageId } from "./thread-lookup";
/** A References header is a whitespace (occasionally comma) separated list of Message-IDs. */
export function parseMessageIdList(value: string | null | undefined): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const token of (value ?? "").split(/[\s,]+/)) {
		const id = normalizeMessageId(token);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		result.push(id);
	}
	return result;
}

export function formatMessageIdHeader(ids: string[]): string {
	return ids.map((id) => `<${id}>`).join(" ");
}

/**
 * The References line a reply should carry: the parent's own chain followed by
 * the parent itself. Long chains keep the root and the most recent ancestors,
 * which is what mail clients use to reconstruct a conversation.
 */
export function buildReplyReferences(
	parentReferences: string[],
	parentMessageId: string | null,
): string[] {
	const ids = [...parentReferences];
	const parent = normalizeMessageId(parentMessageId);
	if (parent && !ids.includes(parent)) ids.push(parent);
	const MAX = 30;
	if (ids.length <= MAX) return ids;
	return [ids[0] ?? "", ...ids.slice(ids.length - (MAX - 1))];
}
