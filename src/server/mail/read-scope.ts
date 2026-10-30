import type { User } from "../../shared/contracts";
import { withDatabase } from "../db";

// Mailbox visibility belongs to the inbox. Editing a draft remains author-scoped.
export async function readMailboxScope(
	user: User,
	mailboxId?: string,
	allowedIds?: string[] | null,
) {
	const allowed = allowedIds == null ? null : JSON.stringify(allowedIds);
	const mailboxes = await withDatabase(
		(sql) => sql.SourceReadMailboxes`
 SELECT b.id,b.user_id,b.local_part,b.display_name,b.type,d.hostname
 FROM mailboxes b JOIN domains d ON d.id=b.domain_id
 WHERE b.disabled=0 AND (${mailboxId ?? null} IS NULL OR b.id=${mailboxId ?? null})
 AND (${allowed} IS NULL OR b.id IN(SELECT value FROM json_each(${allowed})))
 AND (b.user_id=${user.id} OR (b.type='shared'
 AND EXISTS(SELECT 1 FROM license_settings l WHERE l.id='default' AND l.plan='team' AND l.state='active')
 AND EXISTS(SELECT 1 FROM mailbox_access a WHERE a.mailbox_id=b.id AND a.user_id=${user.id} AND a.permission IN('read_only','send_on_behalf','send_as','full_access'))))`,
	);
	if (mailboxId && !mailboxes.length)
		throw new Response("Mailbox not found", { status: 404 });
	return {
		mailboxes,
		ids: JSON.stringify(mailboxes.map((row) => row.id)),
		fallback: !mailboxId && !mailboxes.length && allowedIds == null ? 1 : 0,
	};
}
