import { getClientAsset } from "./assets";
import { withDatabase, seconds } from "./db";
import { licenseEntitlements } from "./licenses";
import { LocalStorage } from "./storage";
import type { Branding } from "../lib/branding/types";
const iconKey = "branding/app-icon";
export async function branding(): Promise<Branding> {
	const { canCustomizeBranding } = await licenseEntitlements();
	if (!canCustomizeBranding)
		return {
			appName: "Mailflare",
			hasCustomIcon: false,
			canCustomizeBranding: false,
		};
	const [row] = await withDatabase(
		(sql) =>
			sql.NativeBranding`SELECT app_name,icon_key FROM app_settings WHERE id='default'`,
	);
	return {
		appName: row?.app_name || "Mailflare",
		hasCustomIcon: !!row?.icon_key,
		canCustomizeBranding: true,
	};
}
export async function brandingApi(
	request: Request,
	canEdit = false,
): Promise<Response | null> {
	const path = new URL(request.url).pathname;
	if (path === "/api/branding" && request.method === "GET")
		return Response.json(await branding(), {
			headers: { "Cache-Control": "no-store" },
		});
	if (path === "/api/branding/icon" && request.method === "GET") {
		if (!(await branding()).hasCustomIcon) {
			const icon = getClientAsset("icon-96.png");
			return icon
				? new Response(icon, {
						headers: {
							"Content-Type": "image/png",
							"Cache-Control": "no-cache",
						},
					})
				: new Response("Not found", { status: 404 });
		}
		const file = new LocalStorage().file(iconKey);
		if (!(await file.exists()))
			return new Response("Not found", { status: 404 });
		const bytes = await file.bytes();
		const type =
			bytes[0] === 0x89
				? "image/png"
				: bytes[0] === 0xff
					? "image/jpeg"
					: new TextDecoder().decode(bytes.slice(0, 4)) === "GIF8"
						? "image/gif"
						: "image/webp";
		return new Response(bytes, {
			headers: {
				"Content-Type": type,
				"X-Content-Type-Options": "nosniff",
				"Cache-Control": "no-cache",
			},
		});
	}
	if (path !== "/api/branding" || request.method !== "PUT") return null;
	if (!canEdit) throw new Response("Forbidden", { status: 403 });
	if (!(await licenseEntitlements()).canCustomizeBranding)
		throw new Response(
			"A Pro or Team license is required to customize branding",
			{ status: 403 },
		);
	const form = await request.formData(),
		appName = String(form.get("appName") ?? "").trim(),
		icon = form.get("icon");
	if (!appName || appName.length > 60)
		throw new Response("App name must be between 1 and 60 characters", {
			status: 400,
		});
	const upload = icon instanceof File && icon.size > 0 ? icon : null;
	if (
		upload &&
		!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
			upload.type,
		)
	)
		throw new Response("Use a PNG, JPEG, WebP, or GIF image", { status: 400 });
	if (upload && upload.size > 2 * 1024 * 1024)
		throw new Response("Icon must be 2 MB or smaller", { status: 413 });
	if (upload) await new LocalStorage().put(iconKey, await upload.arrayBuffer());
	await withDatabase(
		(sql) =>
			sql.NativeUpdateBranding`INSERT INTO app_settings (id,app_name,icon_key,updated_at) VALUES ('default',${appName},${upload ? iconKey : null},${seconds()}) ON CONFLICT(id) DO UPDATE SET app_name=excluded.app_name,icon_key=COALESCE(excluded.icon_key,app_settings.icon_key),updated_at=excluded.updated_at`,
	);
	return Response.json(await branding());
}
