import type { AppSQL } from "../../server/db";
import { getEmailAddress } from "@/lib/email/address";
import { analyzeAuthentication } from "./analyzers/authentication";
import { getReputationKeys } from "./analyzers/reputation";
import { analyzeStructure } from "./analyzers/structure";
import { analyzeUrls } from "./analyzers/urls";
import { classifyTokens } from "./classifier";
import {
	buildFingerprint,
	getDomain,
	prepareSpamContent,
	tokenizeMessage,
} from "./tokenizer";
import type {
	SpamAnalysisInput,
	SpamAnalysisResult,
	SpamSignal,
} from "./types";
import { SPAM_THRESHOLDS, SPAM_WEIGHTS } from "./weights";
import { LocalSpamIntelligenceProvider } from "./providers/local";

export async function analyzeSpam(
	sql: AppSQL,
	input: SpamAnalysisInput,
): Promise<SpamAnalysisResult> {
	const prepared = prepareSpamContent(input.message);
	const fingerprint = buildFingerprint(input.message, prepared);
	const sender = getEmailAddress(
		input.message.fromAddr ?? input.envelopeFrom,
	).toLowerCase();
	const signals: SpamSignal[] = [
		...analyzeAuthentication(input.headers),
		...analyzeUrls(input.message, prepared),
		...analyzeStructure(input.message, input.headers, prepared),
	];
	const intelligenceProvider =
		input.intelligenceProvider ?? new LocalSpamIntelligenceProvider();
	signals.push(
		...(await intelligenceProvider.check({
			senderDomain: getDomain(sender),
			urlDomains: prepared.urlDomains,
			fingerprint,
		})),
	);

	const [contact] = sender
		? await sql.SpamSenderContact`SELECT blocked,source FROM contacts WHERE user_id=${input.userId} AND email=${sender} LIMIT 1`
		: [];
	if (contact?.blocked) {
		return {
			score: 100,
			verdict: "spam",
			signals: [
				{ id: "blocked_sender", score: 100, reason: "Sender is blocked" },
			],
			fingerprint,
		};
	}
	if (contact?.source === "manual")
		signals.push({
			id: "manual_contact",
			score: SPAM_WEIGHTS.relationships.manuallySavedContact,
			reason: "Sender is in your manually saved contacts",
		});
	if (contact?.source === "outbound")
		signals.push({
			id: "previously_sent",
			score: SPAM_WEIGHTS.relationships.previouslySentTo,
			reason: "You have previously sent email to this address",
		});

	const identities = getReputationKeys(input.message, fingerprint);
	const reputationRecords = await Promise.all(
		identities.map(async (identity) => {
			const [record] =
				await sql.SpamSenderReputation`/* @notNull spamCount */ /* @notNull hamCount */ SELECT spam_count AS spamCount,ham_count AS hamCount FROM spam_reputation WHERE mailbox_id=${input.mailboxId} AND type=${identity.type} AND key=${identity.key} LIMIT 1`;
			return { identity, record };
		}),
	);
	const reputationSignals: SpamSignal[] = [];
	for (const { identity, record } of reputationRecords) {
		if (!record || record.spamCount + record.hamCount < 3) continue;
		const spamRatio =
			(record.spamCount + 1) / (record.spamCount + record.hamCount + 2);
		if (spamRatio >= 0.8)
			reputationSignals.push({
				id: `poor_${identity.type}_reputation`,
				score: SPAM_WEIGHTS.reputation.establishedSpam,
				reason: `${identity.type === "fingerprint" ? "Similar messages have" : "This sender has"} repeatedly been marked as spam`,
			});
		if (spamRatio <= 0.2)
			reputationSignals.push({
				id: `good_${identity.type}_reputation`,
				score: SPAM_WEIGHTS.reputation.establishedHam,
				reason: `${identity.type === "fingerprint" ? "Similar messages have" : "This sender has"} repeatedly been marked as legitimate`,
			});
	}
	const strongestReputation = reputationSignals.sort(
		(a, b) => Math.abs(b.score) - Math.abs(a.score),
	)[0];
	if (strongestReputation) signals.push(strongestReputation);

	const bayesian = await classifyTokens(
		sql,
		input.mailboxId,
		tokenizeMessage(input.message, prepared),
	);
	if (bayesian.contribution !== 0)
		signals.push({
			id: bayesian.contribution > 0 ? "bayesian_spam" : "bayesian_ham",
			score: bayesian.contribution,
			reason:
				bayesian.contribution > 0
					? "Content resembles messages previously marked as spam"
					: "Content resembles messages previously marked as legitimate",
			metadata: {
				probability: Number(bayesian.probability.toFixed(3)),
				trainedMessages: bayesian.trainedMessages,
			},
		});

	const rawScore = signals.reduce((total, signal) => total + signal.score, 0);
	const score = Math.max(0, Math.min(100, rawScore));
	if (rawScore !== score)
		signals.push({
			id: "score_boundary",
			score: score - rawScore,
			reason:
				rawScore > 100
					? "Score is capped at 100"
					: "Score cannot be lower than 0",
		});
	const verdict =
		score >= SPAM_THRESHOLDS.spam
			? "spam"
			: score >= SPAM_THRESHOLDS.suspicious
				? "suspicious"
				: "inbox";
	return {
		score,
		verdict,
		signals: signals.filter(
			(signal) => Math.abs(signal.score) >= 2 || signal.id === "score_boundary",
		),
		contentProbability: bayesian.probability,
		fingerprint,
	};
}
