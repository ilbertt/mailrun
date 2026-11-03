import { getCookie } from "@tanstack/react-start/server";
import { getClientAsset } from "../../server/assets";
import {
	LOCALE_COOKIE,
	DEFAULT_LOCALE,
	createTranslator,
	loadMessages,
	resolveLocale,
} from "./utils";
import type { Locale, Messages } from "./types";

/** The locale chosen in the preference cookie, for server code that must render in it. */
export async function getRequestLocale() {
	return resolveLocale(getCookie(LOCALE_COOKIE));
}

/** Server-side catalog load through the static assets binding; English when the catalog cannot be read. */
export async function loadServerMessages(
	locale: Locale,
): Promise<Partial<Messages> | undefined> {
	if (locale === DEFAULT_LOCALE) return undefined;
	try {
		return await loadMessages(locale, async (path) => {
			const file = getClientAsset(path.slice(1));
			return file
				? new Response(file)
				: new Response("Not found", { status: 404 });
		});
	} catch (error) {
		console.warn(
			`Falling back to English: ${error instanceof Error ? error.message : error}`,
		);
		return undefined;
	}
}

// For server components and route handlers; client components use `useLanguage()`.
export async function getServerTranslator() {
	const locale = await getRequestLocale();
	return createTranslator(locale, await loadServerMessages(locale));
}
