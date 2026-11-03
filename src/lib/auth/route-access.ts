import type { User } from "../../shared/contracts";

const adminPrefixes = [
	"/admin",
	"/routing",
	"/accounts",
	"/domains",
	"/mailboxes",
	"/agent",
	"/api-keys",
	"/webhooks",
	"/backups",
	"/branding",
	"/licenses",
	"/activity",
	"/audit-logs",
	"/general",
	"/ai-usage",
];
const primaryPrefixes = [
	"/agent",
	"/api-keys",
	"/webhooks",
	"/backups",
	"/branding",
	"/licenses",
	"/activity",
	"/audit-logs",
	"/general",
	"/ai-usage",
];
const matches = (path: string, prefixes: string[]) =>
	!path.startsWith("/agent/review/") &&
	prefixes.some((prefix) => path === prefix || path.startsWith(prefix + "/"));
export const isAdminMailRoute = (path: string) => matches(path, adminPrefixes);

export function protectedRouteAccess(
	session: { user: User | null; needsSetup: boolean; needsOnboarding: boolean },
	pathname: string,
): { redirect: "/setup" | "/login" | "/inbox" | "/admin" } | { user: User } {
	if (session.needsSetup) return { redirect: "/setup" };
	if (!session.user) return { redirect: "/login" };
	if (session.needsOnboarding && isAdminMailRoute(pathname))
		return { redirect: "/setup" };
	if (isAdminMailRoute(pathname) && session.user.role !== "admin")
		return { redirect: "/inbox" };
	if (matches(pathname, primaryPrefixes) && !session.user.isPrimaryAdmin)
		return { redirect: "/admin" };
	return { user: session.user };
}
