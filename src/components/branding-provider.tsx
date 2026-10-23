// Branding is read by the shared Mailflare shell; server-backed overrides are
// added with the branding settings port rather than changing the source UI.
export function useBranding() {
	return { appName: "Mailflare", iconUrl: "/icon.png" };
}
