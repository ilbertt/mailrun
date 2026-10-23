import { withDatabase } from "../db";
import type { User } from "../../shared/contracts";
export async function mailboxAccess(
	user: User,
	mailboxId: string,
	level: "read" | "send" | "manage" = "read",
) {
	const [row] = await withDatabase(
		(sql) => sql.MailboxPermission`
		/* @notNull id */
		/* @notNull user_id */
		SELECT b.id,b.user_id,b.domain_id,b.local_part,b.use_all_domains,d.hostname,d.user_id AS domain_owner
		FROM mailboxes b JOIN domains d ON d.id=b.domain_id
		WHERE b.id=${mailboxId} AND b.disabled=0 AND (b.user_id=${user.id} OR d.user_id=${user.id} OR EXISTS (
			SELECT 1 FROM mailbox_access a WHERE a.mailbox_id=b.id AND a.user_id=${user.id}
			AND (${level}='read' OR a.permission='full_access' OR (${level}='send' AND a.permission IN ('send_as','send_on_behalf')))
		)) LIMIT 1`,
	);
	if (!row) throw new Error("Mailbox not found or permission denied");
	return row;
}
export async function managedDomain(user: User, domainId: string) {
	const [domain] = await withDatabase(
		(sql) =>
			sql.ManagedDomain`SELECT id,hostname,user_id FROM domains WHERE id=${domainId} AND user_id=${user.id}`,
	);
	if (!domain) throw new Error("Domain not found or permission denied");
	return domain;
}
