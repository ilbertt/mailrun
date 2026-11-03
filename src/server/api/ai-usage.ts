import { withDatabase } from "../db";
import type { User } from "../../shared/contracts";
import { primaryAgentAdmin } from "../agent/provider";
import { getRequestTimeZone, recentZonedDays } from "../../lib/time/utils";
export async function aiUsageApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	if (new URL(request.url).pathname !== "/api/admin/ai-usage") return null;
	await withDatabase((sql) => primaryAgentAdmin(sql, user));
	if (request.method !== "GET")
		return new Response(null, { status: 405, headers: { Allow: "GET" } });
	const page = Number(new URL(request.url).searchParams.get("page") ?? "1"),
		size = 20;
	if (
		!Number.isSafeInteger(page) ||
		page < 1 ||
		page > Math.floor(Number.MAX_SAFE_INTEGER / size)
	)
		return Response.json({ error: "Invalid page" }, { status: 400 });
	const [profile] = await withDatabase(
			(sql) =>
				sql.NativeAiUsageTimeZone`SELECT time_zone FROM users WHERE id=${user.id}`,
		),
		zone = getRequestTimeZone(request, profile?.time_zone),
		days = recentZonedDays(zone, 30),
		ranges = days.map((day) => ({
			date: day.date,
			start: day.start.getTime() / 1000,
			end: day.end.getTime() / 1000,
		}));
	const [totals] = await withDatabase(
		(sql) =>
			sql.NativeAiUsageTotals`/* @type requests number */
/* @type input_tokens number */
/* @type output_tokens number */
/* @type cost_usd_micros number */
/* @type priced_requests number */ SELECT count(*) AS requests,coalesce(sum(input_tokens),0) AS input_tokens,coalesce(sum(output_tokens),0) AS output_tokens,coalesce(sum(cost_usd_micros),0) AS cost_usd_micros,count(cost_usd_micros) AS priced_requests FROM ai_usage`,
	);
	const daily = await withDatabase(
		(sql) =>
			sql.NativeAiUsageDaily`/* @type date string */
/* @type requests number */
/* @type inputTokens number */
/* @type outputTokens number */ SELECT json_extract(d.value,'$.date') AS date,count(u.id) AS requests,coalesce(sum(u.input_tokens),0) AS inputTokens,coalesce(sum(u.output_tokens),0) AS outputTokens FROM json_each(${JSON.stringify(ranges)}) d LEFT JOIN ai_usage u ON u.created_at>=json_extract(d.value,'$.start') AND u.created_at<json_extract(d.value,'$.end') GROUP BY json_extract(d.value,'$.date') ORDER BY date`,
	);
	const rows = await withDatabase(
		(sql) =>
			sql.NativeAiUsagePage`SELECT * FROM ai_usage ORDER BY created_at DESC,id DESC LIMIT ${size} OFFSET ${(page - 1) * size}`,
	);
	const count = Number(totals?.requests ?? 0),
		input = Number(totals?.input_tokens ?? 0),
		output = Number(totals?.output_tokens ?? 0);
	return Response.json(
		{
			totals: {
				requests: count,
				inputTokens: input,
				outputTokens: output,
				costUsdMicros: Number(totals?.cost_usd_micros ?? 0),
				pricedRequests: Number(totals?.priced_requests ?? 0),
				totalTokens: input + output,
			},
			daily,
			timeZone: zone,
			rows: rows.map((row) => ({
				id: row.id,
				createdAt: new Date(row.created_at * 1000),
				provider: row.provider,
				model: row.model,
				source: row.source,
				inputTokens: row.input_tokens,
				outputTokens: row.output_tokens,
				costUsdMicros: row.cost_usd_micros,
			})),
			page,
			pageSize: size,
			totalPages: Math.max(1, Math.ceil(count / size)),
		},
		{ headers: { "Cache-Control": "no-store" } },
	);
}
