import { z } from "zod";
import { withDatabase, seconds } from "../db";
import { mailboxAccess } from "../mail/access";
import { getAgentProviderPublicConfig } from "./provider";
import { withToolMutation } from "./access";
import type { User } from "../../shared/contracts";
export const mailboxAgentSchema = z.object({
	mailboxId: z.string().min(1),
	enabled: z.boolean(),
	modelId: z.string().max(200).nullable().optional(),
	autoDraftEnabled: z.boolean(),
	reviewerUserId: z.string().nullable().optional(),
	instructions: z.string().max(4000),
	dailyLimit: z.number().int().min(1).max(100),
});
export async function getMailboxAgentSettings(user: User, mailboxId: string) {
	const access = await mailboxAccess(user, mailboxId),
		[saved] = await withDatabase(
			(sql) =>
				sql.NativeMailboxAgentSettings`SELECT * FROM mailbox_agent_settings WHERE mailbox_id=${mailboxId}`,
		);
	let canManage = false;
	try {
		await mailboxAccess(user, mailboxId, "manage");
		canManage = true;
	} catch {}
	const reviewers = canManage
		? await withDatabase(
				(sql) =>
					sql.NativeAgentReviewers`SELECT u.id,u.name,u.email FROM users u WHERE u.rowid IN(SELECT rowid FROM users ORDER BY rowid LIMIT 200) AND u.disabled=0 AND (u.id=${access.user_id} OR (EXISTS(SELECT 1 FROM mailboxes b WHERE b.id=${mailboxId} AND b.type='shared' AND b.disabled=0) AND EXISTS(SELECT 1 FROM license_settings WHERE id='default' AND plan='team' AND state='active') AND EXISTS(SELECT 1 FROM mailbox_access a WHERE a.mailbox_id=${mailboxId} AND a.user_id=u.id AND a.permission IN('full_access','send_as','send_on_behalf')))) ORDER BY u.rowid LIMIT 200`,
			)
		: [];
	const provider = await getAgentProviderPublicConfig(),
		[box] = await withDatabase(
			(sql) =>
				sql.NativeAgentAutoReplySetting`SELECT auto_reply_enabled FROM mailboxes WHERE id=${mailboxId}`,
		),
		modelId =
			saved?.model_id && provider.models.includes(saved.model_id)
				? saved.model_id
				: (provider.models[0] ?? null);
	return {
		settings: saved
			? {
					mailboxId: saved.mailbox_id,
					enabled: true,
					modelId,
					autoDraftEnabled: !!saved.auto_draft_enabled,
					reviewerUserId: saved.reviewer_user_id,
					instructions: saved.instructions,
					dailyLimit: saved.daily_limit,
					updatedAt: new Date(saved.updated_at * 1000),
				}
			: {
					mailboxId,
					enabled: true,
					modelId,
					autoDraftEnabled: false,
					reviewerUserId: access.user_id,
					instructions: "",
					dailyLimit: 25,
				},
		models: provider.models,
		canManage,
		canConfigureProvider: user.role === "admin" && user.isPrimaryAdmin,
		providerConfigured: provider.configured,
		provider: provider.configured
			? {
					kind:
						provider.preset === "custom"
							? "OpenAI-compatible API"
							: provider.preset,
					model: provider.model,
				}
			: null,
		autoReplyEnabled: !!box?.auto_reply_enabled,
		reviewers,
	};
}
export async function saveMailboxAgentSettings(
	user: User,
	input: z.infer<typeof mailboxAgentSchema>,
) {
	const access = await mailboxAccess(user, input.mailboxId, "manage"),
		reviewerId = input.reviewerUserId || access.user_id,
		provider = await getAgentProviderPublicConfig();
	if (input.modelId && !provider.models.includes(input.modelId))
		throw new Error("Choose a configured model");
	const model = input.modelId || provider.models[0] || null;
	await withToolMutation(
		{ user, mailboxId: input.mailboxId, origin: "chat" },
		"manage",
		async (sql) => {
			const [reviewer] =
				await sql.NativeAgentReviewerGuard`SELECT u.id FROM users u JOIN mailboxes b ON b.id=${input.mailboxId} WHERE u.id=${reviewerId} AND u.disabled=0 AND (b.user_id=u.id OR (b.type='shared' AND EXISTS(SELECT 1 FROM license_settings WHERE id='default' AND plan='team' AND state='active') AND EXISTS(SELECT 1 FROM mailbox_access a WHERE a.mailbox_id=b.id AND a.user_id=u.id AND a.permission IN('full_access','send_as','send_on_behalf'))))`;
			if (!reviewer) throw new Error("Reviewer needs mailbox send permission");
			const [box] =
				await sql.NativeAgentSettingsAutoReplyGuard`SELECT auto_reply_enabled FROM mailboxes WHERE id=${input.mailboxId}`;
			if (input.autoDraftEnabled && box?.auto_reply_enabled)
				throw new Error(
					"Disable the out-of-office auto-reply before enabling AI drafts",
				);
			await sql.NativeSaveMailboxAgentSettings`INSERT INTO mailbox_agent_settings(mailbox_id,enabled,model_id,auto_draft_enabled,reviewer_user_id,instructions,daily_limit,updated_at) VALUES(${input.mailboxId},1,${model},${input.autoDraftEnabled ? 1 : 0},${reviewerId},${input.instructions},${input.dailyLimit},${seconds()}) ON CONFLICT(mailbox_id) DO UPDATE SET enabled=1,model_id=excluded.model_id,auto_draft_enabled=excluded.auto_draft_enabled,reviewer_user_id=excluded.reviewer_user_id,instructions=excluded.instructions,daily_limit=excluded.daily_limit,updated_at=excluded.updated_at`;
			if (!input.autoDraftEnabled)
				await sql.NativeDisableMailboxAgentJobs`UPDATE agent_jobs SET status='skipped',reason='Auto-drafting disabled' WHERE mailbox_id=${input.mailboxId} AND status='pending'`;
		},
	);
}
