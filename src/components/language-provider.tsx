import en from "../lib/i18n/en.json";
import type { TranslationKey } from "../lib/i18n/types";
export function useLanguage() {
	return {
		t: (key: TranslationKey, values: Record<string, string | number> = {}) => {
			let text: string = en[key];
			for (const [name, value] of Object.entries(values))
				text = text.replaceAll(`{${name}}`, String(value));
			return text;
		},
	};
}
