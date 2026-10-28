import { z } from "zod";
import type { AwsConfig } from "../../lib/aws/aws-types";
import type { CloudflareFetch } from "../cloudflare/client";
import { OutboundProviderError } from "../mail/provider-error";
import { signAwsRequest } from "./sigv4";
import { xmlTag } from "./xml";
export class AwsError extends OutboundProviderError {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string,
	) {
		super(message);
	}
	get accessDenied() {
		return (
			/AccessDenied|UnauthorizedOperation|AuthorizationError|NotAuthorized|Forbidden/i.test(
				this.code,
			) || this.status === 403
		);
	}
}
export type AwsRequest = {
	service: string;
	host?: string;
	method?: string;
	path?: string;
	query?: Record<string, string>;
	body?: string | Uint8Array<ArrayBuffer> | ArrayBuffer | Blob;
	headers?: Record<string, string>;
	region?: string;
	payloadHash?: string;
};
export const awsSuffix = (region: string) =>
	region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
export class AwsClient {
	constructor(
		readonly config: AwsConfig,
		readonly send: CloudflareFetch = fetch,
	) {}
	redact(value: string) {
		let result = value;
		for (const secret of [
			this.config.secretAccessKey,
			this.config.accessKeyId,
			this.config.sessionToken,
		])
			if (secret) result = result.replaceAll(secret, "[redacted]");
		return result.slice(0, 2000);
	}
	async request(input: AwsRequest) {
		const region = input.region ?? this.config.region;
		if (!/^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(region))
			throw new OutboundProviderError(`"${region}" is not a valid AWS region`);
		const url = new URL(
			`https://${input.host ?? `${input.service}.${region}.${awsSuffix(region)}`}${input.path ?? "/"}`,
		);
		for (const [key, value] of Object.entries(input.query ?? {}))
			url.searchParams.set(key, value);
		const body = input.body ?? "",
			method = input.method ?? "GET";
		let payloadHash: string | undefined = input.payloadHash;
		if (body instanceof Blob && !payloadHash) {
			const hasher = new Bun.CryptoHasher("sha256");
			const reader = body.stream().getReader();
			try {
				for (;;) {
					const next = await reader.read();
					if (next.done) break;
					hasher.update(next.value);
				}
			} finally {
				await reader.cancel().catch(() => undefined);
				reader.releaseLock();
			}
			payloadHash = hasher.digest("hex");
		}
		const headers = await signAwsRequest({
			method,
			url,
			region,
			service: input.service,
			credentials: this.config,
			headers: input.headers ?? {},
			body: body instanceof Blob ? "" : body,
			payloadHash,
		});
		let response: Response;
		try {
			response = await this.send(url, {
				method,
				headers,
				body: method === "GET" || method === "HEAD" ? undefined : body,
				redirect: "manual",
				signal: AbortSignal.timeout(90_000),
			});
		} catch (error) {
			throw new OutboundProviderError(
				this.redact(
					error instanceof Error ? error.message : "Could not reach AWS",
				),
			);
		}
		if (!response.ok) {
			const text = await response.text().catch(() => ""),
				json = z
					.object({
						__type: z.string().optional(),
						message: z.string().optional(),
						Message: z.string().optional(),
					})
					.safeParse(
						(() => {
							try {
								return JSON.parse(text) as unknown;
							} catch {
								return null;
							}
						})(),
					);
			const code =
				response.headers.get("x-amzn-errortype")?.split(":")[0] ||
				(json.success ? json.data.__type?.split("#").pop() : undefined) ||
				xmlTag(text, "Code") ||
				`HTTP${response.status}`;
			const message =
				(json.success ? (json.data.message ?? json.data.Message) : undefined) ||
				xmlTag(text, "Message") ||
				`AWS request failed (${response.status})`;
			throw new AwsError(this.redact(message), response.status, code);
		}
		return response;
	}
	async json<T>(
		schema: z.ZodType<T>,
		request: AwsRequest & { json?: unknown },
	) {
		const response = await this.request({
			...request,
			body:
				request.json === undefined
					? request.body
					: JSON.stringify(request.json),
			headers: { "Content-Type": "application/json", ...request.headers },
		});
		const text = await response.text();
		let value: unknown;
		try {
			value = text ? JSON.parse(text) : {};
		} catch {
			throw new OutboundProviderError("AWS returned invalid JSON");
		}
		const result = schema.safeParse(value);
		if (!result.success)
			throw new OutboundProviderError("AWS returned unexpected data");
		return result.data;
	}
	async query(
		service: string,
		version: string,
		action: string,
		params: Record<string, string> = {},
		options: { host?: string; signingService?: string } = {},
	) {
		const response = await this.request({
			service: options.signingService ?? service,
			host:
				options.host ??
				`${service}.${this.config.region}.${awsSuffix(this.config.region)}`,
			method: "POST",
			body: new URLSearchParams({
				Action: action,
				Version: version,
				...params,
			}).toString(),
			headers: {
				"Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
			},
		});
		return response.text();
	}
	async empty(request: AwsRequest) {
		const response = await this.request(request);
		await response.body?.cancel();
	}
}
