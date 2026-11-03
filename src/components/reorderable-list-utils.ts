import { z } from "zod";
import type { ReorderableLayout } from "./reorderable-list-types";

/**
 * Saved placement first (dropping ids that no longer exist or repeat), then any item the
 * layout has never seen goes at the end of its default list.
 */
export function resolveLayout(
	defaults: ReorderableLayout,
	stored: ReorderableLayout,
): ReorderableLayout {
	const known = new Set(Object.values(defaults).flat());
	const placed = new Set<string>();
	const layout: ReorderableLayout = {};
	for (const listId of Object.keys(defaults)) {
		layout[listId] = (stored[listId] ?? []).filter(
			(id) => known.has(id) && !placed.has(id) && !!placed.add(id),
		);
	}
	for (const [listId, ids] of Object.entries(defaults)) {
		for (const id of ids) if (!placed.has(id)) (layout[listId] ??= []).push(id);
	}
	return layout;
}

/** Take `id` out of whichever list holds it and insert it into `listId` before `beforeId` (end when null). */
export function moveItem(
	layout: ReorderableLayout,
	id: string,
	listId: string,
	beforeId: string | null,
): ReorderableLayout {
	const next: ReorderableLayout = {};
	for (const [key, ids] of Object.entries(layout))
		next[key] = ids.filter((item) => item !== id);
	const target = next[listId] ?? [];
	const index = beforeId === null ? -1 : target.indexOf(beforeId);
	if (index < 0) target.push(id);
	else target.splice(index, 0, id);
	next[listId] = target;
	return next;
}

export function readStorage(key: string, fallback: boolean): boolean;
export function readStorage(
	key: string,
	fallback: ReorderableLayout,
): ReorderableLayout;
export function readStorage(
	key: string,
	fallback: boolean | ReorderableLayout,
): boolean | ReorderableLayout {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) return fallback;
		const value: unknown = JSON.parse(raw);
		if (typeof fallback === "boolean")
			return typeof value === "boolean" ? value : fallback;
		const parsed = z.record(z.string(), z.array(z.string())).safeParse(value);
		return parsed.success ? parsed.data : fallback;
	} catch {
		return fallback;
	}
}

export function writeStorage(key: string, value: unknown) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Storage can be unavailable (private windows); the setting just won't persist.
	}
}
