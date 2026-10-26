import { isDriveCategory, type DriveCategory } from "./category-names";
export { DRIVE_CATEGORIES, isDriveCategory } from "./category-names";
export type { DriveCategory } from "./category-names";
const photos = new Set([
	"jpg",
	"jpeg",
	"png",
	"gif",
	"webp",
	"avif",
	"heic",
	"heif",
	"bmp",
	"tif",
	"tiff",
	"svg",
	"raw",
	"dng",
]);
const videos = new Set([
	"mp4",
	"mov",
	"m4v",
	"mkv",
	"webm",
	"avi",
	"wmv",
	"mpg",
	"mpeg",
	"3gp",
]);
const documents = new Set([
	"pdf",
	"doc",
	"docx",
	"xls",
	"xlsx",
	"ppt",
	"pptx",
	"txt",
	"md",
	"csv",
	"rtf",
	"odt",
	"ods",
	"odp",
	"pages",
	"numbers",
	"key",
	"epub",
]);
export function parseDriveCategories(value: string | null) {
	return [...new Set((value ?? "").split(",").filter(isDriveCategory))];
}
export function driveCategory(
	contentType: string,
	name: string,
): DriveCategory {
	const type = contentType.toLowerCase(),
		extension = name.toLowerCase().split(".").at(-1) ?? "";
	if (type.startsWith("image/") || photos.has(extension)) return "photos";
	if (type.startsWith("video/") || videos.has(extension)) return "videos";
	if (
		type.startsWith("text/") ||
		type.startsWith("application/vnd.") ||
		[
			"application/pdf",
			"application/msword",
			"application/rtf",
			"application/json",
			"application/epub+zip",
		].includes(type) ||
		documents.has(extension)
	)
		return "documents";
	return "others";
}
