/** Deployment credentials are authoritative; a saved token keeps migrated installs usable without env credentials. */
export function cloudflareCredentials(
	saved?: { api_token: string; account_id: string } | null,
) {
	return {
		apiToken: process.env.CF_TOKEN?.trim() || saved?.api_token || null,
		// A token rotation must not silently move an existing relay/domain to another account.
		accountId: saved?.account_id || process.env.CF_ACCOUNT_ID?.trim() || null,
	};
}
