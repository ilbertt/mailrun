import { sendPushNotifications } from "./push";
import type { ServerWebSocket } from "bun";
import { z } from "zod";
import { withDatabase } from "./db";
import { getUser } from "./auth/service";
import { mailboxAccess } from "./mail/access";
import type { NewMessageEvent } from "../hooks/message-realtime-types";
export type RealtimeSession = { userId: string; token: string };
declare global {
	var __mailrunSockets: Set<ServerWebSocket<RealtimeSession>> | undefined;
}
const sockets = () => (globalThis.__mailrunSockets ??= new Set());
export async function userMailRevision(userId: string) {
	const rows = await withDatabase(
		(sql) =>
			sql.NativeRealtimeRevision`/* @notNull id */ SELECT b.id,COALESCE(r.revision,0) AS revision,CASE WHEN b.user_id=${userId} THEN 'owner' ELSE a.permission END AS permission FROM mailboxes b LEFT JOIN mailbox_access a ON a.mailbox_id=b.id AND a.user_id=${userId} LEFT JOIN jmap_mailbox_revisions r ON r.mailbox_id=b.id WHERE b.disabled=0 AND (b.user_id=${userId} OR (b.type='shared' AND a.user_id=${userId} AND EXISTS(SELECT 1 FROM license_settings l WHERE l.id='default' AND l.plan='team' AND l.state='active'))) ORDER BY b.id`,
	);
	return JSON.stringify(
		rows.map((row) => [row.id, row.revision, row.permission]),
	);
}
const pingSchema = z.object({
	type: z.literal("ping"),
	revision: z.string().max(60000).nullable(),
});
export const realtimeWebsocket = {
	maxPayloadLength: 65536,
	idleTimeout: 90,
	open(socket: ServerWebSocket<RealtimeSession>) {
		sockets().add(socket);
	},
	close(socket: ServerWebSocket<RealtimeSession>) {
		sockets().delete(socket);
	},
	async message(
		socket: ServerWebSocket<RealtimeSession>,
		message: string | Buffer,
	) {
		try {
			const user = await getUser(socket.data.token);
			if (!user || user.id !== socket.data.userId) {
				socket.close(1008, "Session expired");
				return;
			}
			if (message === "ping") {
				socket.send("pong");
				return;
			}
			if (typeof message !== "string") return;
			const input = pingSchema.safeParse(JSON.parse(message));
			if (!input.success) return;
			const revision = await userMailRevision(user.id);
			socket.send(
				JSON.stringify({
					type: "revision",
					revision,
					changed:
						input.data.revision !== null && input.data.revision !== revision,
				}),
			);
		} catch {
			socket.close(1011, "Revision lookup failed");
		}
	},
};
export async function notifyNewMessage(payload: NewMessageEvent) {
	const push = sendPushNotifications(payload.mailboxId, payload).catch(
		(error) => console.error("Push delivery failed", error),
	);
	const recipients = new Map<string, ServerWebSocket<RealtimeSession>[]>();
	for (const socket of sockets()) {
		const current = recipients.get(socket.data.userId) ?? [];
		current.push(socket);
		recipients.set(socket.data.userId, current);
	}
	for (const group of recipients.values()) {
		for (const socket of group) {
			const user = await getUser(socket.data.token);
			if (!user) {
				socket.close(1008, "Session expired");
				continue;
			}
			try {
				await mailboxAccess(user, payload.mailboxId);
				socket.send(JSON.stringify(payload));
			} catch {
				/* Sharing may have been revoked since the connection opened. */
			}
		}
	}
	await push;
}

export function closeRealtimeConnections() {
	for (const socket of sockets()) socket.close(1001, "Server restarting");
	sockets().clear();
}

export async function notifyAgentDraft(
	userId: string,
	mailboxId: string,
	draftId: string,
) {
	for (const socket of sockets()) {
		if (socket.data.userId !== userId) continue;
		try {
			const user = await getUser(socket.data.token);
			if (!user) {
				socket.close(1008, "Session expired");
				continue;
			}
			await mailboxAccess(user, mailboxId);
			socket.send(JSON.stringify({ type: "agent_draft", mailboxId, draftId }));
		} catch {
			/* Sharing or the connection may have changed. */
		}
	}
}
