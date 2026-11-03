import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { serveV1Api } from "../api/v1";
import { requireMcpScope, type McpPrincipal } from "./auth";
const adminInput = z.object({
	action: z.string(),
	id: z.string().optional(),
	data: z.record(z.string(), z.unknown()).optional(),
});
const output = (value: unknown, isError = false) => ({
	content: [{ type: "text" as const, text: JSON.stringify(value) }],
	isError,
});
const descriptions = {
	domains:
		"List, inspect, create, or delete domains and inspect or set up DNS records. Actions: list, get, create, delete, dns, setup_dns. Pass id for a domain action and data for create or setup_dns.",
	accounts:
		"List, inspect, create, or update managed accounts. Actions: list, get, create, update. Pass id for get or update and data for create or update. For create, data accepts username, domainId, password, role?, useAllDomains? (defaults to true for compatibility), and aliases?: [{ domainId, localPart }]. Set useAllDomains to false to assign only the primary address and explicit aliases. Requires a Pro or Team license; Pro is limited to its account seats.",
	mailboxes:
		"List, inspect, create, update, or delete mailboxes. These actions manage mailbox configuration, not message content. Actions: list, get, create, update, delete. Pass id for get, update, or delete and data for create or update.",
	storage:
		"Show the local nibrun storage holding raw mail, attachments, Drive files, avatars and backups, and test it. Actions: status, test (writes, reads and deletes a small object). Credentials are never returned.",
};
export function registerAdminMcpTools(
	server: McpServer,
	principal: McpPrincipal,
	baseUrl: string,
	authorization: string,
) {
	for (const scope of [
		"domains",
		"accounts",
		"mailboxes",
		"storage",
	] as const) {
		if (!principal.scopes.includes(scope)) continue;
		server.registerTool(
			`manage_${scope}`,
			{ description: descriptions[scope], inputSchema: adminInput },
			async ({ action, id, data }) => {
				try {
					await requireMcpScope(principal, scope);
					const required =
						scope === "domains"
							? ["get", "delete", "dns", "setup_dns"]
							: scope === "accounts"
								? ["get", "update"]
								: scope === "mailboxes"
									? ["get", "update", "delete"]
									: [];
					if (required.includes(action) && !id)
						return output(
							{
								error: `${scope === "domains" ? "Domain" : scope === "accounts" ? "Account" : "Mailbox"} id required`,
							},
							true,
						);
					const allowed =
						scope === "domains"
							? ["list", "get", "create", "delete", "dns", "setup_dns"]
							: scope === "accounts"
								? ["list", "get", "create", "update"]
								: scope === "mailboxes"
									? ["list", "get", "create", "update", "delete"]
									: ["status", "test"];
					if (!allowed.includes(action))
						return output({ error: "Unknown action" }, true);
					const method =
							action === "delete"
								? "DELETE"
								: action === "update"
									? "PATCH"
									: ["create", "setup_dns", "test"].includes(action)
										? "POST"
										: "GET",
						path = `/api/v1/${scope}${required.includes(action) ? `/${encodeURIComponent(id!)}` : ""}${action === "dns" ? "/dns" : action === "setup_dns" ? "/dns/setup" : ""}`;
					const response = await serveV1Api(
						new Request(new URL(path, baseUrl), {
							method,
							headers: {
								Authorization: authorization,
								...(method === "POST" || method === "PATCH"
									? { "Content-Type": "application/json" }
									: {}),
							},
							body:
								method === "POST" || method === "PATCH"
									? JSON.stringify(data ?? {})
									: undefined,
						}),
					);
					return output(
						{
							status: response.status,
							data: await response
								.json()
								.catch(() => ({ error: "Request failed" })),
						},
						!response.ok,
					);
				} catch (error) {
					return output(
						{
							error:
								error instanceof Error ? error.message : "Permission denied",
						},
						true,
					);
				}
			},
		);
	}
}
