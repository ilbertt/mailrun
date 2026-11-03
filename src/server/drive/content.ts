import type { DriveRow } from "../../lib/drive/types";
import { getInlineContentType } from "../../lib/http/content-type";
import { driveContentDisposition, driveObjectKey } from "../../lib/drive/utils";
import { LocalStorage } from "../storage";
export function parseByteRange(
	header: string | null,
	size: number,
): { start: number; end: number } | "invalid" | null {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
	if (!match || (match[1] === "" && match[2] === "")) return null;
	let start: number, end: number;
	if (match[1] === "") {
		const suffix = Number(match[2]);
		if (!Number.isSafeInteger(suffix) || suffix === 0) return "invalid";
		start = Math.max(size - suffix, 0);
		end = size - 1;
	} else {
		start = Number(match[1]);
		end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
	}
	return !Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start >= size ||
		start > end
		? "invalid"
		: { start, end };
}
export async function streamDriveFile(
	request: Request,
	item: DriveRow,
	download: boolean,
) {
	if (item.kind !== "file") return new Response("Not a file", { status: 400 });
	const inline = download ? null : getInlineContentType(item.contentType),
		etag = `"${item.id}-${item.updatedAt.getTime().toString(36)}-${item.size.toString(36)}"`;
	const headers = new Headers({
		"Content-Type": inline ?? "application/octet-stream",
		"Content-Disposition": driveContentDisposition(item.name, inline !== null),
		"Accept-Ranges": "bytes",
		ETag: etag,
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy":
			inline === "application/pdf"
				? "frame-ancestors 'self'"
				: "default-src 'none'; style-src 'unsafe-inline'; sandbox",
		"X-Frame-Options": "SAMEORIGIN",
		"Referrer-Policy": "no-referrer",
		"Cache-Control": "private, no-store",
	});
	const range =
		request.headers.get("if-range") && request.headers.get("if-range") !== etag
			? null
			: parseByteRange(request.headers.get("range"), item.size);
	if (range === "invalid") {
		headers.set("Content-Range", `bytes */${item.size}`);
		return new Response(null, { status: 416, headers });
	}
	const file = new LocalStorage().file(
		item.r2Key ?? driveObjectKey(item.ownerId, item.id),
	);
	if (!(await file.exists()))
		return new Response("File not found", { status: 404 });
	if (range) {
		headers.set(
			"Content-Range",
			`bytes ${range.start}-${range.end}/${item.size}`,
		);
		headers.set("Content-Length", String(range.end - range.start + 1));
		return new Response(
			request.method === "HEAD" ? null : file.slice(range.start, range.end + 1),
			{ status: 206, headers },
		);
	}
	headers.set("Content-Length", String(item.size));
	return new Response(request.method === "HEAD" ? null : file, { headers });
}
