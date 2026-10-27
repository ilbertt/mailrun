import { withDatabase, id, seconds } from "../db";
export function activityMetadata(request: Request) {
	const ua = request.headers.get("user-agent") ?? "",
		value = (name: string) => request.headers.get(name)?.trim() || null;
	return {
		ipAddress:
			value("cf-connecting-ip") ||
			value("x-forwarded-for")?.split(",")[0]?.trim() ||
			"Unknown",
		city: value("cf-ipcity"),
		country: value("cf-ipcountry"),
		device: /ipad|tablet/i.test(ua)
			? "Tablet"
			: /mobi|iphone|android/i.test(ua)
				? "Mobile"
				: "Desktop",
		platform: /windows/i.test(ua)
			? "Windows"
			: /iphone|ipad|ios/i.test(ua)
				? "iOS"
				: /android/i.test(ua)
					? "Android"
					: /mac os|macintosh/i.test(ua)
						? "macOS"
						: /linux/i.test(ua)
							? "Linux"
							: "Unknown",
		userAgent: ua,
	};
}
export async function recordAuthActivity(
	action:
		| "auth.login"
		| "auth.logout"
		| "auth.mfa_verified"
		| "auth.password_reset",
	userId: string,
	request: Request,
) {
	try {
		await withDatabase(
			(sql) =>
				sql.NativeRecordAuthActivity`INSERT INTO audit_logs(id,actor_user_id,target_user_id,action,metadata,created_at) VALUES(${id("audit")},${userId},${userId},${action},${JSON.stringify(activityMetadata(request))},${seconds()})`,
		);
	} catch {
		/* Activity logging must not break authentication. */
	}
}
