import type { User } from "../../shared/contracts";
import type { CloudflareFetch } from "../cloudflare/client";
import { withDatabase } from "../db";
import { publicOrigin } from "../config";
import { AwsClient } from "../aws/client";
import {
	awsConfigSchema,
	assertAwsAdmin,
	getAwsConfig,
	getAwsConfigStatus,
	saveAwsConfig,
	clearAwsConfig,
} from "../aws/settings";
import {
	AWS_IAM_POLICY,
	AwsCredentialsError,
	validateAwsConfig,
} from "../aws/validate";
export async function awsApi(
	request: Request,
	user: User,
	send: CloudflareFetch = fetch,
): Promise<Response | null> {
	if (new URL(request.url).pathname !== "/api/admin/aws") return null;
	await withDatabase((sql) => assertAwsAdmin(sql, user));
	const json = (body: unknown, status = 200) =>
		Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
	if (request.method === "GET")
		return json({ status: await getAwsConfigStatus(), policy: AWS_IAM_POLICY });
	if (
		!request.headers.get("Authorization")?.startsWith("Bearer ") &&
		request.headers.get("Sec-Fetch-Site") !== "same-origin" &&
		request.headers.get("Origin") !== publicOrigin()
	)
		return json({ error: "Invalid origin" }, 403);
	if (request.method === "DELETE")
		return json({ status: await clearAwsConfig(user) });
	try {
		if (request.method === "PUT") {
			const input = awsConfigSchema.safeParse(
				await request.json().catch(() => null),
			);
			if (!input.success)
				return json(
					{
						error:
							input.error.issues[0]?.message ??
							"Enter an access key ID, secret and region",
					},
					400,
				);
			const report = await validateAwsConfig(new AwsClient(input.data, send));
			if (!report.sending && !report.receiving)
				return json(
					{
						error:
							"These credentials work but have no SES permissions. Attach the policy shown below.",
						report,
						policy: AWS_IAM_POLICY,
					},
					400,
				);
			const status = await saveAwsConfig(user, input.data, report.accountId);
			return json({ status, report });
		}
		if (request.method === "POST") {
			const config = await getAwsConfig();
			if (!config)
				return json({ error: "No AWS credentials are configured" }, 400);
			return json({
				report: await validateAwsConfig(new AwsClient(config, send)),
			});
		}
	} catch (error) {
		if (error instanceof Response) throw error;
		return json(
			{ error: error instanceof Error ? error.message : "Could not reach AWS" },
			error instanceof AwsCredentialsError ? 400 : 502,
		);
	}
	return new Response(null, { status: 405 });
}
