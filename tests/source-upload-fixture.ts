import { join } from "node:path";
import capture from "./source-uploads-capture.json";
import { LocalStorage } from "../src/server/storage";

export const sourceUploadsCapture = capture;
export async function prepareSourceUploads(directory: string) {
	const bucket = join(directory, "original-bucket"),
		store = new LocalStorage(bucket);
	for (const file of capture.files) {
		const bytes = Buffer.from(file.base64, "base64");
		if (
			new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== file.sha256
		)
			throw new Error("Original upload fixture hash mismatch");
		await store.put(file.key, bytes);
	}
	const backup = join(directory, "original-records.json");
	await new LocalStorage(directory).put(
		"original-records.json",
		JSON.stringify(capture.backup),
	);
	return { bucket, backup };
}
