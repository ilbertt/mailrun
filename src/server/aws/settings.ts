import { z } from "zod";
import type {
	AwsConfig,
	AwsConfigStatus,
	SesReceivingState,
} from "../../lib/aws/aws-types";
import type { User } from "../../shared/contracts";
import { withDatabase, seconds, type AppSQL } from "../db";
import { adminWrite } from "../admin/accounts";
import { keyActor } from "../auth/key-management";
import { OutboundProviderError } from "../mail/provider-error";
export const SES_RECEIVING_REGIONS = [
	"us-east-1",
	"us-east-2",
	"us-west-2",
	"ap-south-1",
	"ap-southeast-1",
	"ap-southeast-2",
	"ap-northeast-1",
	"ca-central-1",
	"eu-central-1",
	"eu-west-1",
	"eu-west-2",
	"sa-east-1",
	"us-gov-west-1",
];
export const isValidRegion = (region: string) =>
	/^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(region);
export const awsConfigSchema = z.object({
	accessKeyId: z
		.string()
		.trim()
		.regex(
			/^[A-Z0-9]{16,128}$/,
			"That does not look like an AWS access key ID",
		),
	secretAccessKey: z.string().trim().min(20).max(200),
	region: z.string().trim().toLowerCase(),
	sessionToken: z.string().min(1).max(8192).optional(),
});
const storedConfig = awsConfigSchema.extend({
	accountId: z.string().optional(),
});
function parseJson(text: string | null | undefined): unknown {
	try {
		return text ? JSON.parse(text) : null;
	} catch {
		return null;
	}
}
async function readSettings(sql: AppSQL) {
	const [row] =
		await sql.NativeAwsSettings`SELECT aws_config,ses_receiving FROM app_settings WHERE id='default'`;
	return row;
}
async function configuration(sql: AppSQL) {
	const row = await readSettings(sql),
		stored = storedConfig.safeParse(parseJson(row?.aws_config));
	if (stored.success)
		return {
			config: awsConfigSchema.parse(stored.data),
			source: "settings" as const,
			accountId: stored.data.accountId ?? null,
		};
	const environment = awsConfigSchema.safeParse({
		accessKeyId: process.env.AWS_ACCESS_KEY_ID?.trim(),
		secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY?.trim(),
		region: (process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION)?.trim(),
		...(process.env.AWS_SESSION_TOKEN?.trim()
			? { sessionToken: process.env.AWS_SESSION_TOKEN.trim() }
			: {}),
	});
	return {
		config: environment.success ? environment.data : null,
		source: environment.success ? ("environment" as const) : null,
		accountId: null,
	};
}
export function getAwsConfig(sql?: AppSQL): Promise<AwsConfig | null> {
	return sql
		? configuration(sql).then((row) => row.config)
		: withDatabase((current) => getAwsConfig(current));
}
export async function requireAwsConfig() {
	const value = await getAwsConfig();
	if (!value)
		throw new OutboundProviderError(
			"AWS is selected but no credentials are configured",
		);
	return value;
}
export function getAwsConfigStatus(sql?: AppSQL): Promise<AwsConfigStatus> {
	if (!sql) return withDatabase((current) => getAwsConfigStatus(current));
	return configuration(sql).then((row) =>
		row.config
			? {
					configured: true,
					source: row.source,
					region: row.config.region,
					accessKeyHint: row.config.accessKeyId.slice(-4),
					accountId: row.accountId,
				}
			: {
					configured: false,
					source: null,
					region: null,
					accessKeyHint: null,
					accountId: null,
				},
	);
}
export async function assertAwsAdmin(sql: AppSQL, user: User) {
	try {
		await keyActor(sql, user, true);
	} catch (error) {
		if (error instanceof Response && error.status === 403)
			throw new Response(
				"Only the primary administrator can manage AWS credentials",
				{ status: 403 },
			);
		throw error;
	}
}
export function saveAwsConfig(
	user: User,
	config: AwsConfig,
	accountId: string,
) {
	return adminWrite(async (sql) => {
		await assertAwsAdmin(sql, user);
		await sql.NativeSaveAwsConfig`INSERT INTO app_settings(id,aws_config,updated_at) VALUES('default',${JSON.stringify({ ...config, accountId })},${seconds()}) ON CONFLICT(id) DO UPDATE SET aws_config=excluded.aws_config,updated_at=excluded.updated_at`;
		return getAwsConfigStatus(sql);
	});
}
export function clearAwsConfig(user: User) {
	return adminWrite(async (sql) => {
		await assertAwsAdmin(sql, user);
		await sql.NativeClearAwsConfig`UPDATE app_settings SET aws_config=NULL,updated_at=${seconds()} WHERE id='default'`;
		return getAwsConfigStatus(sql);
	});
}
const receiving = z.object({
	region: z.string().refine(isValidRegion),
	bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
	topicArn: z
		.string()
		.regex(/^arn:aws(?:-us-gov|-cn)?:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]+$/),
	ruleSet: z.string().min(1).max(64),
	token: z.string().min(16),
	endpoint: z.url(),
	accountId: z.string().regex(/^\d{12}$/),
});
export function getSesReceivingState(
	sql?: AppSQL,
): Promise<SesReceivingState | null> {
	if (!sql) return withDatabase((current) => getSesReceivingState(current));
	return readSettings(sql).then((row) => {
		const result = receiving.safeParse(parseJson(row?.ses_receiving));
		return result.success ? result.data : null;
	});
}
export function saveSesReceivingState(
	config: AwsConfig,
	state: SesReceivingState,
	assertOwned: (sql: AppSQL) => Promise<void>,
) {
	return adminWrite(async (sql) => {
		await assertOwned(sql);
		const current = await getAwsConfig(sql);
		if (!current || JSON.stringify(current) !== JSON.stringify(config))
			throw new Error("AWS credentials changed. Try setup again.");
		const value = JSON.stringify(receiving.parse(state));
		await sql.NativeSaveSesReceiving`INSERT INTO app_settings(id,ses_receiving,updated_at) VALUES('default',${value},${seconds()}) ON CONFLICT(id) DO UPDATE SET ses_receiving=excluded.ses_receiving,updated_at=excluded.updated_at`;
	});
}
