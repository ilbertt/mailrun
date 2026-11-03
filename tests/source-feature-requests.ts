// GET routes exercised against the actual original and imported servers.
// Mailbox listing includes the original personal-inbox repair side effect.
export const sourceFeatureRequests = [
	"/api/auth/me",
	"/api/branding",
	"/api/mailboxes",
	"/api/mailboxes/mailbox/aliases",
	"/api/routing-rules?mailboxId=mailbox",
	"/api/webhooks",
	"/api/webhooks/source-webhook/deliveries",
	"/api/backups",
	"/api/templates",
	"/api/calendar/events?start=2026-11-01T00%3A00%3A00Z&end=2026-12-01T00%3A00%3A00Z",
	"/api/booking",
	"/api/agent/settings?mailboxId=mailbox",
	"/api/agent/conversations?mailboxId=mailbox",
	"/api/agent/conversations/source-conversation?mailboxId=mailbox",
	"/api/drive/items",
	"/api/drive/items?parent=source-drive-folder",
	"/api/drive/items/source-drive-file/shares",
	"/api/api-keys",
	"/api/messages?mailboxId=mailbox&status=draft",
	"/api/drafts/source-draft",
	"/api/agent/jobs?mailboxId=mailbox",
	"/api/agent/approvals/source-approval",
	"/api/drive/items/source-drive-file/content",
	"/api/backups/source-backup/download",
];
export const sourceFeatureSession = "source-feature-session-only";

// GET /api/mailboxes can create a personal inbox. Compare its generated identity
// separately; all pre-existing records and all other DTO fields remain exact.
export function comparableFeatureResponse(
	path: string,
	body: unknown,
	originalMailboxIds: string[],
): unknown {
	if (path !== "/api/mailboxes") return body;
	const value = JSON.parse(JSON.stringify(body)) as {
		mailboxes?: {
			id: string;
			userId: string;
			type: string;
			localPart: string;
			createdAt: string;
		}[];
	};
	for (const row of value.mailboxes ?? []) {
		if (
			!originalMailboxIds.includes(row.id) &&
			row.userId === "owner" &&
			row.type === "personal" &&
			row.localPart === "owner"
		) {
			row.id = "$generated-personal-mailbox";
			row.createdAt = "$generated-at";
		}
	}
	return value;
}

export async function readFeatureBody(response: Response): Promise<unknown> {
	if (response.headers.get("Content-Type")?.includes("application/json"))
		return response.json();
	const bytes = await response.arrayBuffer();
	return {
		$file: {
			contentType: response.headers.get("Content-Type"),
			byteLength: bytes.byteLength,
			sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
		},
	};
}
