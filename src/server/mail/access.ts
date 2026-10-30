import { withDatabase } from "../db";
import type { User } from "../../shared/contracts";
export class MailboxAccessError extends Error {
	constructor() {
		super("Mailbox not found or permission denied");
		this.name = "MailboxAccessError";
	}
}
export async function mailboxAccess(
	user: User,
	mailboxId: string,
	level: "read" | "send" | "manage" = "read",
) {
	const [row] = await withDatabase(
		(sql) => sql.MailboxPermission`
		/* @notNull id */
		/* @notNull user_id */
		SELECT b.id,b.user_id,b.domain_id,b.local_part,b.use_all_domains,b.display_name,b.type,d.hostname,d.user_id AS domain_owner,owner.name AS owner_name,owner.email AS owner_email,CASE WHEN b.user_id=${user.id} THEN 'full_access' ELSE (SELECT permission FROM mailbox_access WHERE mailbox_id=b.id AND user_id=${user.id} LIMIT 1) END AS permission
		FROM mailboxes b JOIN domains d ON d.id=b.domain_id JOIN users owner ON owner.id=b.user_id
		WHERE b.id=${mailboxId} AND b.disabled=0 AND (b.user_id=${user.id} OR (b.type='shared' AND EXISTS(SELECT 1 FROM license_settings l WHERE l.id='default' AND l.plan='team' AND l.state='active') AND EXISTS (
			SELECT 1 FROM mailbox_access a WHERE a.mailbox_id=b.id AND a.user_id=${user.id}
			AND a.permission IN('read_only','send_on_behalf','send_as','full_access')
			AND (${level}='read' OR a.permission='full_access' OR (${level}='send' AND a.permission IN ('send_as','send_on_behalf')))
		))) LIMIT 1`,
	);
	if (!row) throw new MailboxAccessError();
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
