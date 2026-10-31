import { z } from "zod";
import type { CloudflareFetch } from "../cloudflare/client";
import { OutboundProviderError } from "../mail/provider-error";
const record = z.object({
	record: z.string(),
	name: z.string(),
	type: z.enum(["MX", "TXT", "CNAME"]),
	value: z.string(),
	ttl: z.union([z.string(), z.number()]).optional(),
	status: z.string().optional(),
	priority: z.number().optional(),
});
const domain = z.object({
	id: z.string(),
	name: z.string(),
	status: z.string(),
	capabilities: z
		.object({
			sending: z.string().optional(),
			receiving: z.string().optional(),
		})
		.optional(),
	records: z.array(record).optional(),
});
const webhook = z.object({
	id: z.string(),
	endpoint: z.string(),
	events: z.array(z.string()).optional(),
});
export type ResendDomain = z.infer<typeof domain>;
export type ResendRecord = z.infer<typeof record>;
export type Capabilities = { sending: boolean; receiving: boolean };
export class ResendRestrictedKeyError extends Error {
	constructor() {
		super(
			"This Resend key can only send mail, so Mailflare cannot add or check domains. Add the domain in the Resend dashboard, or use a full-access key.",
		);
	}
}
export class ResendApiError extends OutboundProviderError {}
export class ResendTransportError extends OutboundProviderError {}
export class ResendClient {
	constructor(
		readonly apiKey: string,
		readonly send: CloudflareFetch = fetch,
	) {}
	async request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}) {
		let response: Response;
		try {
			response = await this.send("https://api.resend.com" + path, {
				...init,
				headers: {
					Authorization: "Bearer " + this.apiKey,
					"Content-Type": "application/json",
					...init.headers,
				},
				redirect: "manual",
				signal: init.signal ?? AbortSignal.timeout(30_000),
			});
		} catch (error) {
			throw new ResendTransportError(
				error instanceof Error
					? error.message.replaceAll(this.apiKey, "[redacted]").slice(0, 2000)
					: "Could not reach Resend",
			);
		}
		const body: unknown = await response.json().catch(() => null);
		if (!response.ok) {
			const error = z
				.object({ name: z.string().optional(), message: z.string().optional() })
				.safeParse(body);
			if (error.success && error.data.name === "restricted_api_key")
				throw new ResendRestrictedKeyError();
			throw new ResendApiError(
				"Resend: " +
					(error.success && error.data.message
						? error.data.message
								.replaceAll(this.apiKey, "[redacted]")
								.slice(0, 2000)
						: `request failed (${response.status})`),
			);
		}
		const parsed = schema.safeParse(body);
		if (!parsed.success)
			throw new ResendTransportError("Resend returned unexpected data");
		return parsed.data;
	}
	async checkKey() {
		try {
			await this.request("/domains", z.object({ data: z.array(domain) }));
			return { valid: true, canManageDomains: true };
		} catch (error) {
			if (error instanceof ResendRestrictedKeyError)
				return { valid: true, canManageDomains: false };
			if (error instanceof ResendApiError)
				return { valid: false, canManageDomains: false };
			throw error;
		}
	}
	async findDomain(hostname: string) {
		const result = await this.request(
			"/domains",
			z.object({ data: z.array(domain) }),
		);
		const found = result.data.find(
			(row) => row.name.toLowerCase() === hostname.toLowerCase(),
		);
		return found ? this.getDomain(found.id) : null;
	}
	getDomain(id: string) {
		return this.request("/domains/" + encodeURIComponent(id), domain);
	}
	createDomain(hostname: string, capabilities: Capabilities) {
		return this.request("/domains", domain, {
			method: "POST",
			body: JSON.stringify({
				name: hostname,
				capabilities: {
					sending: capabilities.sending ? "enabled" : "disabled",
					receiving: capabilities.receiving ? "enabled" : "disabled",
				},
			}),
		});
	}
	async capabilities(id: string, value: Partial<Capabilities>) {
		await this.request("/domains/" + encodeURIComponent(id), z.unknown(), {
			method: "PATCH",
			body: JSON.stringify({
				capabilities: {
					...(value.sending === undefined
						? {}
						: { sending: value.sending ? "enabled" : "disabled" }),
					...(value.receiving === undefined
						? {}
						: { receiving: value.receiving ? "enabled" : "disabled" }),
				},
			}),
		});
	}
	async verifyDomain(id: string) {
		await this.request(
			"/domains/" + encodeURIComponent(id) + "/verify",
			z.unknown(),
			{ method: "POST" },
		);
	}
	async deleteDomain(id: string) {
		await this.request("/domains/" + encodeURIComponent(id), z.unknown(), {
			method: "DELETE",
		});
	}
	async webhooks() {
		return (
			await this.request("/webhooks", z.object({ data: z.array(webhook) }))
		).data;
	}
	createWebhook(endpoint: string) {
		return this.request(
			"/webhooks",
			z.object({ id: z.string(), signing_secret: z.string().min(1) }),
			{
				method: "POST",
				body: JSON.stringify({ endpoint, events: ["email.received"] }),
			},
		);
	}
	async deleteWebhook(id: string) {
		await this.request("/webhooks/" + encodeURIComponent(id), z.unknown(), {
			method: "DELETE",
		});
	}
	receivedEmail(id: string) {
		return this.request(
			"/emails/receiving/" + encodeURIComponent(id),
			z.object({
				id: z.string(),
				from: z.string(),
				to: z.array(z.string()),
				cc: z.array(z.string()).nullish(),
				bcc: z.array(z.string()).nullish(),
				raw: z
					.object({ download_url: z.url(), expires_at: z.string().optional() })
					.nullish(),
			}),
		);
	}
}
