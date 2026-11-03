import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...values: ClassValue[]) {
	return twMerge(clsx(values));
}
export function parseAddress(value: string) {
	const bare = value.trim().match(/<([^>]+)>$/)?.[1] ?? value.trim();
	const match = bare.match(/^([^@\s]+)@([^@\s]+)$/);
	return match?.[1] && match[2]
		? { local: match[1].toLowerCase(), domain: match[2].toLowerCase() }
		: null;
}
