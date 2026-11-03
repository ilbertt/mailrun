import type { AppSQL } from "../../server/db";
import type { BayesianResult } from "./types";
import { MAX_BAYESIAN_TOKENS, SPAM_WEIGHTS } from "./weights";
export async function classifyTokens(
	sql: AppSQL,
	mailboxId: string,
	tokens: string[],
): Promise<BayesianResult> {
	const [totals] =
		await sql.SpamTrainingTotals`SELECT sum(CASE WHEN classification='spam' THEN 1 ELSE 0 END) AS spam_total,sum(CASE WHEN classification='ham' THEN 1 ELSE 0 END) AS ham_total FROM spam_feedback WHERE mailbox_id=${mailboxId}`;
	const spamTotal = Number(totals?.spam_total ?? 0),
		hamTotal = Number(totals?.ham_total ?? 0),
		trainedMessages = spamTotal + hamTotal;
	if (!spamTotal || !hamTotal || !tokens.length)
		return {
			probability: 0.5,
			contribution: 0,
			trainedMessages,
			strongestTokens: [],
		};
	const rows =
		await sql.SpamTrainingTokens`/* @notNull spamCount */ /* @notNull hamCount */ SELECT token,spam_count AS spamCount,ham_count AS hamCount FROM spam_token_stats WHERE mailbox_id=${mailboxId} AND token IN(SELECT value FROM json_each(${JSON.stringify(tokens)}))`;
	const strongestTokens = rows
		.map((row) => {
			const spamRate = (row.spamCount + 1) / (spamTotal + 2);
			const hamRate = (row.hamCount + 1) / (hamTotal + 2);
			const probability = Math.max(
				0.1,
				Math.min(0.9, spamRate / (spamRate + hamRate)),
			);
			return { token: row.token, probability };
		})
		.sort(
			(a, b) => Math.abs(b.probability - 0.5) - Math.abs(a.probability - 0.5),
		)
		.slice(0, MAX_BAYESIAN_TOKENS);
	if (strongestTokens.length === 0)
		return {
			probability: 0.5,
			contribution: 0,
			trainedMessages,
			strongestTokens,
		};

	let spamProduct = 1;
	let hamProduct = 1;
	for (const token of strongestTokens) {
		spamProduct *= token.probability;
		hamProduct *= 1 - token.probability;
	}
	const probability = spamProduct / (spamProduct + hamProduct);
	const fullContribution =
		(probability - 0.5) * SPAM_WEIGHTS.content.maximum * 2;
	const reliability = Math.min(1, Math.min(spamTotal, hamTotal) / 20);
	return {
		probability,
		contribution: Math.round(fullContribution * reliability),
		trainedMessages,
		strongestTokens,
	};
}
