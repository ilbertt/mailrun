import { z } from "zod";
import type { DomainCloudflare } from "../domains/cloudflare";
import type { DnsLookup } from "../domains/dns";
import { authenticateApiKey, hasScope } from "../auth/api-key";
import { apiKeyPrincipal } from "../auth/key-principal";
import { v1Messages } from "../v1/messages";
import { v1Send } from "../v1/send";
import { readPublicSendBody } from "../v1/json-body";
import {
	v1MailboxList,
	v1MailboxGet,
	v1MailboxCreate,
	v1MailboxUpdate,
	v1MailboxDelete,
} from "../v1/mailboxes";
import { storageStatus, v1StorageTest } from "../v1/storage";
import {
	listAccounts,
	accountDetails,
	createAccount,
	updateAccount,
} from "../admin/accounts";
import { domainsApi } from "./domains";
import { readLimitedBody } from "../mail/inbound";
import { apiErrorResponse } from "./errors";
import {
	sendEmailSchema,
	createUserAccountSchema,
	updateManagedAccountSchema,
	mailboxSchema,
	updateMailboxSchema,
	addDomainSchema,
} from "../../lib/validators";
import type { CloudflareFetch } from "../cloudflare/client";
export const isV1Path = (path: string) =>
	path === "/api/v1" || path.startsWith("/api/v1/");
export async function serveV1Api(
	request: Request,
	send: CloudflareFetch = fetch,
	options?: { domainClient?: DomainCloudflare; lookup?: DnsLookup },
): Promise<Response> {
	const json = (value: unknown, status = 200) =>
		Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
	try {
		const url = new URL(request.url),
			path = url.pathname.slice("/api/v1".length),
			method = request.method === "HEAD" ? "GET" : request.method;
		const match =
			/^\/(messages|send|storage|accounts|mailboxes|domains)(?:\/([^/]+)(\/dns(?:\/setup)?)?)?$/.exec(
				path,
			);
		if (!match) return json({ error: "Not found" }, 404);
		const resource = match[1]!,
			id = match[2] ? decodeURIComponent(match[2]) : undefined,
			extra = match[3];
		if (
			(id && ["messages", "send", "storage"].includes(resource)) ||
			(extra && resource !== "domains")
		)
			return json({ error: "Not found" }, 404);
		const allowed =
			resource === "messages"
				? ["GET"]
				: resource === "send"
					? ["POST"]
					: resource === "storage"
						? ["GET", "POST"]
						: resource === "domains" && extra
							? extra === "/dns"
								? ["GET"]
								: ["POST"]
							: id
								? resource === "domains"
									? ["GET", "DELETE"]
									: resource === "mailboxes"
										? ["GET", "PATCH", "DELETE"]
										: ["GET", "PATCH"]
								: ["GET", "POST"];
		if (!allowed.includes(method))
			return new Response(null, {
				status: 405,
				headers: {
					Allow: allowed
						.flatMap((value) => (value === "GET" ? ["GET", "HEAD"] : [value]))
						.join(", "),
				},
			});
		if (!request.headers.get("authorization")?.startsWith("Bearer "))
			return json({ error: "Unauthorized" }, 401);
		const key = await authenticateApiKey(request);
		const scope =
			resource === "messages"
				? "read"
				: resource === "send"
					? "send"
					: resource;
		const administrative = [
			"accounts",
			"mailboxes",
			"domains",
			"storage",
		].includes(scope);
		if (!key) return json({ error: "Unauthorized" }, 401);
		if (
			administrative
				? key.user.role !== "admin" || !key.scopes.includes(scope)
				: !hasScope(key, scope)
		)
			return json({ error: "Unauthorized" }, 401);
		const actor = apiKeyPrincipal(key, scope);
		const read = async (): Promise<unknown> =>
			JSON.parse(
				new TextDecoder().decode(
					await readLimitedBody(
						request,
						resource === "send" ? 40 * 1024 * 1024 : 64 * 1024,
					),
				),
			);
		let response: Response;
		if (resource === "messages")
			response = json({ messages: await v1Messages(request, key) });
		else if (resource === "send") {
			const input = sendEmailSchema.safeParse(
				await readPublicSendBody(request),
			);
			if (!input.success) return json({ error: input.error.flatten() }, 400);
			if (key.mailboxIds && !key.mailboxIds.includes(input.data.mailboxId))
				return json({ error: "Mailbox not found" }, 404);
			try {
				response = json(await v1Send(actor, input.data, send));
			} catch (error) {
				if (error instanceof Response) throw error;
				const message = error instanceof Error ? error.message : "Send failed";
				const status = /not found|permission|not assigned|not match/.test(
					message,
				)
					? 403
					: /Attachments exceed|Subject exceeds|Headers exceed|Message exceeds Cloudflare|At most 50|recipients|attachment limit/.test(
								message,
							)
						? 400
						: 500;
				return json({ error: message }, status);
			}
		} else if (resource === "storage") {
			if (method === "GET")
				response = json({ storage: storageStatus, warning: null });
			else {
				const result = await v1StorageTest();
				response = json(
					{ storage: storageStatus, ...result },
					result.ok ? 200 : 502,
				);
			}
		} else if (resource === "accounts") {
			if (method === "GET" && !id)
				response = json({ accounts: (await listAccounts(actor)).accounts });
			else if (method === "GET" && id) {
				const account = (await accountDetails(actor, id)).account;
				response = json({
					account: {
						id: account.id,
						email: account.email,
						name: account.name,
						role: account.role,
						disabled: account.disabled,
						canManageMailboxes: account.canManageMailboxes,
						forwardingEmail: account.forwardingEmail,
						hasAvatar: account.hasAvatar,
					},
				});
			} else if (method === "POST") {
				const input = createUserAccountSchema.safeParse(await read());
				if (!input.success) return json({ error: input.error.flatten() }, 400);
				response = json(await createAccount(actor, input.data), 201);
			} else {
				const body = await read();
				const input = updateManagedAccountSchema.safeParse(body);
				if (!input.success) return json({ error: input.error.flatten() }, 400);
				response = json(await updateAccount(actor, id!, body));
			}
		} else if (resource === "mailboxes") {
			if (method === "GET")
				response = id
					? json({ mailbox: await v1MailboxGet(actor, id) })
					: json({ mailboxes: await v1MailboxList(actor) });
			else if (method === "POST") {
				const input = mailboxSchema.safeParse(await read());
				if (!input.success) return json({ error: input.error.flatten() }, 400);
				response = json(await v1MailboxCreate(actor, input.data), 201);
			} else if (method === "PATCH") {
				const input = updateMailboxSchema.safeParse(await read());
				if (!input.success) return json({ error: input.error.flatten() }, 400);
				response = json(await v1MailboxUpdate(actor, id!, input.data));
			} else response = json(await v1MailboxDelete(actor, id!));
		} else {
			const target = new URL(url);
			target.pathname = url.pathname.replace("/api/v1/", "/api/");
			if (!id && method === "GET")
				target.searchParams.set("includeDns", "true");
			let adapted: Request;
			if (method === "POST") {
				const body = await read();
				const schema = extra
					? z.object({
							record: z.enum(["mx", "spf", "dkim", "dmarc"]),
							replaceMx: z.boolean().optional(),
						})
					: addDomainSchema;
				const input = schema.safeParse(body);
				if (!input.success)
					return json(
						{ error: extra ? "Unknown DNS record" : input.error.flatten() },
						400,
					);
				const headers = new Headers(request.headers);
				headers.delete("content-length");
				adapted = new Request(target, {
					method,
					headers,
					body: JSON.stringify(input.data),
				});
			} else
				adapted = new Request(target, { method, headers: request.headers });
			response =
				(await domainsApi(
					adapted,
					actor,
					options?.domainClient,
					options?.lookup,
				)) ?? json({ error: "Not found" }, 404);
		}
		const headers = new Headers(response.headers);
		headers.set("Cache-Control", "no-store");
		if (request.method === "HEAD") {
			await response.body?.cancel();
			return new Response(null, { status: response.status, headers });
		}
		return new Response(response.body, { status: response.status, headers });
	} catch (error) {
		if (error instanceof URIError) return json({ error: "Invalid path" }, 400);
		return apiErrorResponse(error);
	}
}
