import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import capture from "./source-outbound-capture.json";
import { restoreBackup } from "../src/lib/backups/export";
import { LocalStorage } from "../src/server/storage";

export const capturedMailSchema = z.object({
	from: z.string(),
	to: z.array(z.string()),
	cc: z.array(z.string()),
	bcc: z.array(z.string()),
	subject: z.string(),
	text: z.string(),
	html: z.string(),
	headers: z.record(z.string(), z.string()),
	attachments: z.array(
		z.object({
			filename: z.string(),
			type: z.string(),
			content: z.string(),
			disposition: z.string(),
			contentId: z.string().optional(),
		}),
	),
});
export const sourceOutboundCapture = capture;
export const expectedSourceMail = z
	.array(capturedMailSchema)
	.parse(capture.expected.deliveries);

export async function restoreSourceOutbound(db: Database) {
	restoreBackup(db, capture.backup);
	for (const object of capture.objects) {
		const bytes = Buffer.from(object.base64, "base64");
		if (createHash("sha256").update(bytes).digest("hex") !== object.sha256)
			throw new Error("Captured source attachment hash mismatch");
		await new LocalStorage().put(object.key, bytes);
	}
}

export async function verifySourceObjects() {
	for (const object of capture.objects) {
		const bytes = await new LocalStorage().file(object.key).arrayBuffer();
		if (
			createHash("sha256").update(new Uint8Array(bytes)).digest("hex") !==
			object.sha256
		)
			throw new Error("Imported source attachment changed");
	}
}
