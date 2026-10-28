import { readMailHeaderBlock } from "../mail/header-block";
import PostalMime from "postal-mime";
import {
	getEmailAddressList,
	normalizeEmailAddress,
} from "../../lib/email/address";
import { listMailboxes } from "../mail/repository";
import { LocalStorage } from "../storage";
import type { AgentToolContext } from "./types";
import type { AgentMessage } from "./messages";
export async function getReplyRecipients(
	ctx: AgentToolContext,
	source: Pick<
		AgentMessage,
		"reply_to" | "from_addr" | "raw_r2_key" | "to_addr" | "cc_addr"
	>,
	replyAll: boolean,
) {
	let recipient =
		getEmailAddressList(source.reply_to).at(0) ??
		normalizeEmailAddress(source.from_addr);
	if (!source.reply_to && source.raw_r2_key) {
		const file = new LocalStorage().file(source.raw_r2_key);
		if (await file.exists()) {
			const parsed = await PostalMime.parse(await readMailHeaderBlock(file));
			const replyTo = parsed.replyTo
				?.flatMap((item) =>
					"address" in item && item.address ? [item.address] : [],
				)
				.at(0);
			if (replyTo) recipient = replyTo.toLowerCase();
		}
	}
	if (!recipient.includes("@")) throw new Error("Source has no reply address");
	const mailbox = (await listMailboxes(ctx.user)).find(
		(box) => box.id === ctx.mailboxId,
	);
	if (!mailbox) throw new Error("Mailbox not found");
	const own = new Set(
		mailbox.senderAddresses.map((value) => value.toLowerCase()),
	);
	if (own.has(recipient))
		throw new Error("Cannot draft a reply to this mailbox");
	const cc = replyAll
		? [
				...new Set([
					...getEmailAddressList(source.to_addr),
					...getEmailAddressList(source.cc_addr),
				]),
			]
				.filter((address) => !own.has(address) && address !== recipient)
				.join(", ")
		: "";
	return { to: recipient, cc };
}
