import { z } from "zod";
import { defaultTranslator, type Translator } from "@/lib/i18n/utils";
import { getAuthHeaders } from "@/lib/auth/client";
import type {
	ImportMessagesResult,
	ImportProgressHandler,
} from "./import-messages-types";

const importResultSchema = z.object({
	imported: z.number().int().nonnegative(),
	skipped: z.number().int().nonnegative(),
	errors: z.array(z.string()),
});
const importErrorSchema = z.object({ error: z.string() });

export async function importMessageFiles(
	mailboxId: string,
	files: File[],
	destination: string,
	onProgress?: ImportProgressHandler,
): Promise<ImportMessagesResult> {
	const form = new FormData();
	form.set("mailboxId", mailboxId);
	form.set("destination", destination);
	for (const file of files) {
		form.append("files", file);
	}

	return new Promise((resolve, reject) => {
		const request = new XMLHttpRequest();
		request.open("POST", "/api/import/messages");
		getAuthHeaders().forEach((value, key) =>
			request.setRequestHeader(key, value),
		);
		request.upload.onprogress = (event) => {
			if (event.lengthComputable)
				onProgress?.(Math.round((event.loaded / event.total) * 70));
		};
		request.onerror = () => reject(new Error("Import upload failed"));
		request.onload = () => {
			try {
				const value: unknown = JSON.parse(request.responseText || "{}");
				if (request.status < 200 || request.status >= 300) {
					const error = importErrorSchema.safeParse(value);
					reject(
						new Error(
							error.success
								? error.data.error
								: request.status === 413
									? "Import upload is too large"
									: "Import failed",
						),
					);
					return;
				}
				const data = importResultSchema.parse(value);
				onProgress?.(100);
				resolve(data);
			} catch {
				reject(
					new Error(
						request.status === 413
							? "Import upload is too large"
							: "Invalid import response",
					),
				);
			}
		};
		request.send(form);
	});
}

export function getImportSummary(
	result: ImportMessagesResult | null,
	t: Translator = defaultTranslator,
): string {
	if (!result) return "";
	return t("import.summary", {
		imported: result.imported ?? 0,
		skipped: result.skipped ?? 0,
	});
}
