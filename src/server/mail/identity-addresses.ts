import type { AppSQL } from "../db";
import { normalizeLocalPart } from "./routing";

type AddressMailbox = {
	id: string;
	domain_id: string;
	local_part: string;
	use_all_domains: number;
	hostname: string;
	domain_owner: string;
};
// Address claims use the same normalized ownership rules for identity sync and
// sender authorization, including disabled mailbox/alias reservations.
async function collectAddresses<Box extends AddressMailbox>(
	sql: AppSQL,
	boxes: Box[],
) {
	if (!boxes.length) return [];
	const wide = boxes.some((box) => !!box.use_all_domains);
	const domains = wide
		? await sql.NativeIdentityDomains`SELECT id,user_id,hostname,status FROM domains`
		: [];
	const aliases = wide
		? await sql.NativeIdentityAliases`SELECT a.mailbox_id,a.domain_id,a.local_part,d.hostname FROM mailbox_aliases a JOIN domains d ON d.id=a.domain_id`
		: await sql.NativeExplicitIdentityAliases`SELECT a.mailbox_id,a.domain_id,a.local_part,d.hostname FROM mailbox_aliases a JOIN domains d ON d.id=a.domain_id WHERE a.mailbox_id IN(SELECT value FROM json_each(${JSON.stringify(boxes.map((box) => box.id))}))`;
	const claims = wide
		? await sql.NativeIdentityClaims`SELECT id,domain_id,local_part FROM mailboxes`
		: [];
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

export async function personalMailboxAddresses(sql: AppSQL, userId: string) {
	const boxes =
		await sql.NativeIdentityMailboxes`/* @notNull id */ /* @notNull domain_owner */ SELECT b.id,b.domain_id,b.local_part,b.use_all_domains,b.display_name,b.avatar_key,d.hostname,d.user_id AS domain_owner FROM mailboxes b JOIN domains d ON d.id=b.domain_id WHERE b.user_id=${userId} AND b.type='personal'`;
	return collectAddresses(sql, boxes);
}
export async function mailboxDomainAddresses(sql: AppSQL, box: AddressMailbox) {
	return (await collectAddresses(sql, [box]))[0]?.addresses ?? [];
}
