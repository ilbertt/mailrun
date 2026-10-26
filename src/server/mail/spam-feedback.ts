import { z } from "zod";
import type { AppSQL } from "../db";
import { seconds } from "../db";
import type { User } from "../../shared/contracts";
import {
	buildFingerprint,
	prepareSpamContent,
	tokenizeMessage,
} from "../../lib/spam/tokenizer";
import { getReputationKeys } from "../../lib/spam/analyzers/reputation";
import { TOKENIZER_VERSION } from "../../lib/spam/weights";
import { audit } from "./message-actions";
export async function spamFeedback(
	sql: AppSQL,
	user: User,
	messageId: string,
	classification: "spam" | "ham",
) {
	const [message] =
		await sql.FeedbackMessage`SELECT * FROM messages WHERE id=${messageId}`;
	if (!message?.mailbox_id || message.direction !== "inbound") return false;
	const [previous] =
		await sql.PreviousSpamFeedback`SELECT classification,training_tokens,reputation_keys FROM spam_feedback WHERE message_id=${messageId}`;
	const status = classification === "spam" ? "spam" : "received";
	if (previous?.classification !== classification) {
		const parsed = {
			subject: message.subject,
			text: message.text_body,
			html: message.html_body,
			messageId: message.provider_message_id,
			fromAddr: message.from_addr,
			toAddr: message.to_addr,
			ccAddr: message.cc_addr,
			bccAddr: message.bcc_addr,
			replyTo: message.reply_to,
			inReplyTo: message.in_reply_to,
			references: message.references_header?.split(/\s+/).filter(Boolean) ?? [],
			date: new Date(message.created_at * 1000),
			attachments: [],
		};
		const prepared = prepareSpamContent(parsed);
		const tokens = previous
			? z.array(z.string()).parse(JSON.parse(previous.training_tokens))
			: tokenizeMessage(parsed, prepared);
		const keys = previous
			? z
					.array(
						z.object({
							type: z.enum(["email", "domain", "fingerprint"]),
							key: z.string(),
						}),
					)
					.parse(JSON.parse(previous.reputation_keys))
			: getReputationKeys(parsed, buildFingerprint(parsed, prepared));
		const add = async (target: "spam" | "ham", amount: 1 | -1) => {
			for (const token of tokens)
				await sql.TrainSpamToken`INSERT INTO spam_token_stats (mailbox_id,token,spam_count,ham_count,updated_at) VALUES (${message.mailbox_id},${token},${target === "spam" ? amount : 0},${target === "ham" ? amount : 0},${seconds()}) ON CONFLICT(mailbox_id,token) DO UPDATE SET spam_count=max(0,spam_count+excluded.spam_count),ham_count=max(0,ham_count+excluded.ham_count),updated_at=excluded.updated_at`;
			for (const key of keys)
				await sql.TrainSpamReputation`INSERT INTO spam_reputation (mailbox_id,type,key,messages_seen,spam_count,ham_count,first_seen_at,last_seen_at) VALUES (${message.mailbox_id},${key.type},${key.key},${amount > 0 ? 1 : 0},${target === "spam" ? amount : 0},${target === "ham" ? amount : 0},${seconds()},${seconds()}) ON CONFLICT(mailbox_id,type,key) DO UPDATE SET messages_seen=max(messages_seen,excluded.messages_seen),spam_count=max(0,spam_count+excluded.spam_count),ham_count=max(0,ham_count+excluded.ham_count),last_seen_at=excluded.last_seen_at`;
		};
		if (previous)
			await add(z.enum(["spam", "ham"]).parse(previous.classification), -1);
		await add(classification, 1);
		await sql.SaveSpamFeedback`INSERT INTO spam_feedback (message_id,mailbox_id,actor_user_id,classification,training_tokens,reputation_keys,tokenizer_version,created_at,updated_at) VALUES (${messageId},${message.mailbox_id},${user.id},${classification},${JSON.stringify(tokens)},${JSON.stringify(keys)},${TOKENIZER_VERSION},${seconds()},${seconds()}) ON CONFLICT(message_id) DO UPDATE SET actor_user_id=excluded.actor_user_id,classification=excluded.classification,updated_at=excluded.updated_at`;
		await audit(
			sql,
			user,
			message.mailbox_id,
			messageId,
			"email.spam_feedback",
			{ classification },
		);
	}
	await sql.ApplySpamVerdict`UPDATE messages SET status=${status},folder_id=NULL,snoozed_until=CASE WHEN ${classification}='ham' THEN NULL ELSE snoozed_until END WHERE id=${messageId}`;
	return true;
}
export async function observeReputation(
	sql: AppSQL,
	mailboxId: string,
	keys: ReturnType<typeof getReputationKeys>,
) {
	for (const key of keys)
		await sql.ObserveSpamReputation`INSERT INTO spam_reputation (mailbox_id,type,key,messages_seen,spam_count,ham_count,first_seen_at,last_seen_at) VALUES (${mailboxId},${key.type},${key.key},1,0,0,${seconds()},${seconds()}) ON CONFLICT(mailbox_id,type,key) DO UPDATE SET messages_seen=messages_seen+1,last_seen_at=excluded.last_seen_at`;
}
