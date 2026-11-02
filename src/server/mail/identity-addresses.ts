import type { AppSQL } from "../db";
import { normalizeLocalPart } from "./routing";

// Identity lookup and profile sync use the same claims as the original address
// resolver. Disabled mailboxes/aliases still reserve their normalized address.
export async function personalMailboxAddresses(sql: AppSQL, userId: string) {
	const boxes =
		await sql.NativeIdentityMailboxes`SELECT b.id,b.domain_id,b.local_part,b.use_all_domains,b.display_name,b.avatar_key,d.hostname,d.user_id AS domain_owner FROM mailboxes b JOIN domains d ON d.id=b.domain_id WHERE b.user_id=${userId} AND b.type='personal'`;
	if (!boxes.length) return [];
	const domains =
		await sql.NativeIdentityDomains`SELECT id,user_id,hostname,status FROM domains`;
	const aliases =
		await sql.NativeIdentityAliases`SELECT a.mailbox_id,a.domain_id,a.local_part,d.hostname FROM mailbox_aliases a JOIN domains d ON d.id=a.domain_id`;
	const claims =
		await sql.NativeIdentityClaims`SELECT id,domain_id,local_part FROM mailboxes`;
	return boxes.map((box) => {
		const local = normalizeLocalPart(box.local_part);
		const reserved = new Set(
			[
				...claims.filter(
					(row) =>
						row.id !== box.id && normalizeLocalPart(row.local_part) === local,
				),
				...aliases.filter(
					(row) =>
						row.mailbox_id !== box.id &&
						normalizeLocalPart(row.local_part) === local,
				),
			].map((row) => row.domain_id),
		);
		const addresses = [
			`${box.local_part}@${box.hostname}`,
			...(box.use_all_domains
				? domains
						.filter(
							(domain) =>
								domain.id !== box.domain_id &&
								domain.user_id === box.domain_owner &&
								domain.status === "active" &&
								!reserved.has(domain.id),
						)
						.map((domain) => `${box.local_part}@${domain.hostname}`)
				: []),
			...aliases
				.filter((alias) => alias.mailbox_id === box.id)
				.map((alias) => `${alias.local_part}@${alias.hostname}`),
		];
		return {
			...box,
			addresses: [
				...new Set(addresses.map((address) => address.toLowerCase())),
			],
		};
	});
}
