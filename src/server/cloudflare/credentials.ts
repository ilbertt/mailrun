import type { CloudflareAuth } from "../../shared/cloudflare-auth";

/** Deployment credentials are authoritative; saved credentials are a fallback. */
export function cloudflareCredentials(
	saved?: {
		api_token: string;
		account_id: string;
		api_key?: string | null;
		api_email?: string | null;
	} | null,
) {
	const token = process.env.CF_TOKEN?.trim(),
		key = process.env.CF_API_KEY?.trim(),
		email = process.env.CF_EMAIL?.trim();
	let auth: CloudflareAuth | null = null;
	// Match the source's global-key-before-token precedence. An incomplete
	// deployment key must not silently revive a different saved credential.
	if (key && email) auth = { kind: "global-key", key, email };
	else if (token) auth = { kind: "token", token };
	else if (!key) {
		if (saved?.api_key && saved.api_email)
			auth = { kind: "global-key", key: saved.api_key, email: saved.api_email };
		else if (saved?.api_token) auth = { kind: "token", token: saved.api_token };
	}
	return {
		auth,
		// A token rotation must not silently move an existing relay/domain to another account.
		accountId: saved?.account_id || process.env.CF_ACCOUNT_ID?.trim() || null,
	};
}

export function cloudflareCredentialColumns(auth: CloudflareAuth) {
	return auth.kind === "global-key"
		? { apiToken: "", apiKey: auth.key, apiEmail: auth.email }
		: { apiToken: auth.token, apiKey: null, apiEmail: null };
}
