import { z } from "zod";
import type { AppSQL } from "../db";
import { withDatabase, seconds, id } from "../db";
import type { CloudflareFetch } from "../cloudflare/client";
import { fetchGravatar } from "./gravatar";
import { LocalStorage } from "../storage";
import { notifyContactAvatar } from "../realtime";
export async function enqueueContactAvatar(
	sql: AppSQL,
	contactId: string,
	userId: string,
	mailboxId?: string,
	create = true,
) {
	if (create)
		await sql.NativeQueueContactAvatar`INSERT INTO mailrun_contact_avatar_jobs(contact_id,created_at) VALUES(${contactId},${seconds()}) ON CONFLICT(contact_id) DO NOTHING`;
	if (mailboxId)
		await sql.NativeAvatarMailboxScope`UPDATE mailrun_contact_avatar_jobs SET mailbox_ids=json_insert(mailbox_ids,'$[#]',${mailboxId}) WHERE contact_id=${contactId} AND status IN('pending','running') AND NOT EXISTS(SELECT 1 FROM json_each(mailbox_ids) WHERE value=${mailboxId}) AND EXISTS(SELECT 1 FROM mailboxes WHERE id=${mailboxId} AND user_id=${userId})`;
}
export async function cancelContactAvatar(sql: AppSQL, contactId: string) {
	await sql.NativeCancelContactAvatar`UPDATE mailrun_contact_avatar_jobs SET status='complete',owner=NULL,lease_until=NULL WHERE contact_id=${contactId}`;
}
export async function runAvatarJobs(
	send: CloudflareFetch = fetch,
	signal?: AbortSignal,
) {
	const owner = id("avatar-dispatch");
	const [lease] = await withDatabase(
		(sql) =>
			sql.NativeClaimAvatarDispatch`INSERT INTO mailrun_job_leases(name,owner,expires_at) VALUES('avatar-dispatch',${owner},${seconds() + 60}) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE mailrun_job_leases.expires_at<${seconds()} RETURNING owner`,
	);
	if (!lease) return 0;
	let count = 0;
	const deadline = Date.now() + 40_000;
	try {
		await withDatabase(
			(sql) =>
				sql.NativeExhaustAvatarJobs`UPDATE mailrun_contact_avatar_jobs SET status='complete',owner=NULL,lease_until=NULL,error='Avatar import interrupted too many times' WHERE status='running' AND lease_until<${seconds()} AND attempts>=3`,
		);
		while (count < 5 && Date.now() < deadline && !signal?.aborted) {
			const token = id("avatar");
			const [claimed] = await withDatabase(
				(sql) =>
					sql.NativeClaimAvatarJob`UPDATE mailrun_contact_avatar_jobs SET status='running',owner=${token},lease_until=${seconds() + 60},attempts=attempts+1 WHERE contact_id=(SELECT j.contact_id FROM mailrun_contact_avatar_jobs j JOIN contacts c ON c.id=j.contact_id JOIN users u ON u.id=c.user_id WHERE u.disabled=0 AND (j.status='pending' OR (j.status='running' AND j.lease_until<${seconds()})) ORDER BY j.created_at,j.contact_id LIMIT 1) RETURNING contact_id`,
			);
			if (!claimed) break;
			count++;
			const [record] = await withDatabase(
				(sql) =>
					sql.NativeClaimedAvatarContact`SELECT c.id,c.user_id,c.email,c.avatar_key FROM contacts c JOIN users u ON u.id=c.user_id JOIN mailrun_contact_avatar_jobs j ON j.contact_id=c.id WHERE c.id=${claimed.contact_id} AND u.disabled=0 AND j.owner=${token} AND j.status='running' AND j.lease_until>=${seconds()}`,
			);
			const contact = record
				? z
						.object({
							id: z.string(),
							user_id: z.string(),
							email: z.string(),
							avatar_key: z.string().nullable(),
						})
						.parse(record)
				: null;
			let key: string | null = null;
			let published = false;
			try {
				if (contact && !contact.avatar_key)
					key = await fetchGravatar(
						contact.user_id,
						contact.email,
						token,
						send,
						signal,
					);
				if (signal?.aborted) throw signal.reason;
				published = await withDatabase((sql) =>
					sql.begin(async (tx) => {
						await tx.NativeAvatarPublishFence`UPDATE app_settings SET updated_at=updated_at WHERE id='default'`;
						const rows =
							key && contact
								? await tx.NativePublishContactAvatar`UPDATE contacts SET avatar_key=${key} WHERE id=${contact.id} AND user_id=${contact.user_id} AND avatar_key IS NULL AND EXISTS(SELECT 1 FROM users WHERE id=${contact.user_id} AND disabled=0) AND EXISTS(SELECT 1 FROM mailrun_contact_avatar_jobs WHERE contact_id=${contact.id} AND owner=${token} AND status='running' AND lease_until>=${seconds()}) RETURNING id`
								: [];
						if (rows.length)
							await tx.NativeBumpAvatarMailboxRevision`INSERT INTO mailrun_contact_avatar_revisions(mailbox_id,revision) SELECT b.id,1 FROM mailboxes b WHERE b.user_id=${contact!.user_id} AND b.id IN(SELECT value FROM mailrun_contact_avatar_jobs j,json_each(j.mailbox_ids) WHERE j.contact_id=${claimed.contact_id} AND j.owner=${token}) ON CONFLICT(mailbox_id) DO UPDATE SET revision=revision+1`;
						await tx.NativeCompleteAvatarJob`UPDATE mailrun_contact_avatar_jobs SET status='complete',published=${rows.length ? 1 : 0},owner=NULL,lease_until=NULL WHERE contact_id=${claimed.contact_id} AND owner=${token} AND status='running' AND lease_until>=${seconds()}`;
						return rows.length > 0;
					}),
				);
				if (!published && key)
					await Promise.all([
						new LocalStorage().delete(key),
						new LocalStorage().delete(key + ":preview"),
					]);
				if (published && contact) {
					const [scope] = await withDatabase(
						(sql) =>
							sql.NativeAvatarNotificationScope`SELECT mailbox_ids FROM mailrun_contact_avatar_jobs WHERE contact_id=${contact.id}`,
					);
					await notifyContactAvatar(
						contact.user_id,
						contact.email,
						scope?.mailbox_ids ?? "[]",
					);
				}
			} catch (error) {
				if (key && !published)
					await Promise.all([
						new LocalStorage().delete(key),
						new LocalStorage().delete(key + ":preview"),
					]);
				await withDatabase(
					(sql) =>
						sql.NativeReleaseAvatarJob`UPDATE mailrun_contact_avatar_jobs SET status=${signal?.aborted ? "pending" : "complete"},owner=NULL,lease_until=NULL,error=${signal?.aborted ? null : "Avatar import failed"} WHERE contact_id=${claimed.contact_id} AND owner=${token} AND status='running'`,
				);
				if (signal?.aborted) break;
			}
		}
		return count;
	} finally {
		await withDatabase(
			(sql) =>
				sql.NativeReleaseAvatarDispatch`DELETE FROM mailrun_job_leases WHERE name='avatar-dispatch' AND owner=${owner}`,
		);
	}
}
