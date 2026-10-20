import { relayDecisionSchema } from "../src/shared/contracts";
import { signRelay } from "../src/shared/relay-signature";

interface EmailMessage {
	from: string; to: string; rawSize: number; raw: ReadableStream<Uint8Array>; headers: Headers;
	setReject(reason: string): void;
	forward(address: string, headers?: Headers): Promise<void>;
}
interface RelayEnvironment { MAILRUN_URL: string; RELAY_SECRET: string }
export default {
	async email(message: EmailMessage, env: RelayEnvironment) {
		if (message.rawSize > 25 * 1024 * 1024) { message.setReject("Message exceeds the 25 MiB receiving limit"); return; }
		const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
		const timestamp = String(Date.now());
		const response = await fetch(`${env.MAILRUN_URL}/api/inbound`, {
			method: "POST", body: raw, signal: AbortSignal.timeout(45_000),
			headers: {
				"Content-Type": "message/rfc822",
				"X-Mailrun-From": message.from, "X-Mailrun-To": message.to,
				"X-Mailrun-Timestamp": timestamp,
				"X-Mailrun-Signature": await signRelay(env.RELAY_SECRET, timestamp, message.from, message.to, raw),
			},
		});
		// Never report successful receipt when the app has not persisted the mail.
		if (!response.ok) throw new Error(`Mailrun could not accept delivery (${response.status})`);
		const decision = relayDecisionSchema.parse(await response.json());
		if (decision.action === "reject") message.setReject(decision.reason);
		if (decision.action === "forward") await message.forward(decision.forwardTo);
	},
	async fetch(request: Request, env: RelayEnvironment) {
		if (new URL(request.url).pathname !== "/health" || request.headers.get("Authorization") !== `Bearer ${env.RELAY_SECRET}`) return new Response("Not found", { status: 404 });
		const timestamp = String(Date.now());
		const raw = new Uint8Array();
		return fetch(`${env.MAILRUN_URL}/api/relay-health`, {
			method: "POST",
			headers: {
				"X-Mailrun-Timestamp": timestamp,
				"X-Mailrun-Signature": await signRelay(env.RELAY_SECRET, timestamp, "", "", raw),
			},
		});
	},
};
