import { z } from "zod";
import { isIP } from "node:net";
import { getEmailAddress, getEmailAddressList } from "../../lib/email/address";
import { verifySvixSignature } from "../../lib/email/svix";
import type { CloudflareFetch } from "../cloudflare/client";
import { readLimitedBody } from "../mail/inbound";
import { ResendClient } from "./client";
import { requireResendKey, resendWebhookSecret } from "./settings";
const max = 25 * 1024 * 1024;
export { intakeProviderMail } from "../mail/provider-intake";
import { intakeProviderMail } from "../mail/provider-intake";
export async function resendInbound(
	request: Request,
	send: CloudflareFetch = fetch,
) {
	const json = (data: unknown, status = 200) =>
		Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
	const secret = (await resendWebhookSecret())?.resend_webhook_secret;
	if (!secret) return json({ error: "Resend receiving is not set up" }, 503);
	let bytes: Uint8Array<ArrayBuffer>;
	try {
		bytes = await readLimitedBody(request, 256 * 1024);
	} catch {
		return json({ error: "Request body too large" }, 413);
	}
	const body = new TextDecoder().decode(bytes);
	if (
		!(await verifySvixSignature(
			secret,
			{
				id: request.headers.get("svix-id"),
				timestamp: request.headers.get("svix-timestamp"),
				signature: request.headers.get("svix-signature"),
			},
			body,
		))
	)
		return json({ error: "Invalid signature" }, 401);
	let event: unknown;
	try {
		event = JSON.parse(body);
	} catch {
		return json({ error: "Invalid body" }, 400);
	}
	const type = z.object({ type: z.unknown().optional() }).safeParse(event);
	if (!type.success) return json({ error: "Invalid body" }, 400);
	if (type.data.type !== "email.received") return json({ ignored: true });
	const received = z
		.object({
			data: z
				.object({
					email_id: z.string().min(1).optional(),
					id: z.string().min(1).optional(),
				})
				.optional(),
		})
		.safeParse(event);
	const emailId = received.success
		? (received.data.data?.email_id ?? received.data.data?.id)
		: undefined;
	if (!emailId) return json({ error: "Missing email id" }, 400);
	try {
		const key = await requireResendKey(),
			client = new ResendClient(key, send),
			email = await client.receivedEmail(emailId);
		const download = email.raw?.download_url;
		if (!download)
			return json({ error: "Resend did not provide the raw message" }, 502);
		// The URL comes from the authenticated API response. Never forward the API
		// key to its download host, and never follow an unexpected redirect.
		const url = new URL(download);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
			/^(localhost|.*\.localhost|.*\.test)$/i.test(url.hostname)
		)
			return json({ error: "Invalid raw message download URL" }, 502);
		const response = await send(url, {
			redirect: "manual",
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok)
			return json({ error: "Could not download the raw message" }, 502);
		if (Number(response.headers.get("Content-Length")) > max) {
			await response.body?.cancel();
			return json({
				delivered: 0,
				dropped: "Message exceeds the 25 MiB receiving limit",
			});
		}
		let raw: Uint8Array<ArrayBuffer>;
		try {
			raw = await readLimitedBody(
				new Request(url, { method: "POST", body: response.body }),
				max,
			);
		} catch (error) {
			if (error instanceof Error && error.message === "Message too large")
				return json({
					delivered: 0,
					dropped: "Message exceeds the 25 MiB receiving limit",
				});
			throw error;
		}
		return json(
			await intakeProviderMail({
				from: email.from,
				recipients: [
					...email.to,
					...(email.cc ?? []),
					...(email.bcc ?? []),
				].flatMap(getEmailAddressList),
				raw,
			}),
		);
	} catch (error) {
		// Do not persist provider URLs (which contain signatures) or credentials in
		// error responses. Non-2xx causes the provider to retry infrastructure errors.
		const message = (
			error instanceof Error ? error.message : "Resend intake failed"
		).replace(/https?:\/\/[^\s)]+/g, "[redacted URL]");
		const key = await requireResendKey().catch(() => null);
		return json(
			{
				error: key
					? message.replaceAll(key, "[redacted]")
					: "Resend intake failed",
			},
			502,
		);
	}
}
