import { useMemo, useCallback } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useRouter, useLocation } from "@tanstack/react-router";
import { useMail } from "./mail-context";
import { mailSettingsQuery, mailboxesQuery } from "../queries";
export type MailboxOption = {
	id: string;
	domainId: string;
	localPart: string;
	hostname: string;
	displayName: string | null;
	signature?: string | null;
	autoReplyEnabled?: boolean;
	autoReplySubject?: string;
	autoReplyBody?: string;
	hasAvatar?: boolean;
	type?: "personal" | "shared";
	permission?: "read_only" | "send_as" | "send_on_behalf" | "full_access";
	isPrimary?: boolean;
	senderAddresses?: string[];
};

export function useSelectedMailbox() {
	const {
		user,
		scopeId,
		mailboxes: rows,
		mailboxesLoading,
		mailboxId,
		setMailboxId,
	} = useMail();
	const router = useRouter();
	const location = useLocation();
	const client = useQueryClient();
	const mailboxes = useMemo<MailboxOption[]>(
		() =>
			rows.map((row) => ({
				id: row.id,
				domainId: row.domain_id,
				localPart: row.local_part,
				hostname: row.hostname,
				displayName: row.display_name,
				signature: row.signature,
				type: row.type === "shared" ? "shared" : "personal",
				permission: row.permission,
				isPrimary: row.isPrimary,
				hasAvatar: !!row.avatar_key,
				autoReplyEnabled: !!row.auto_reply_enabled,
				autoReplySubject: row.auto_reply_subject,
				autoReplyBody: row.auto_reply_body,
				senderAddresses: row.senderAddresses,
			})),
		[rows, user?.email],
	);
	const selectedMailbox =
		mailboxes.find((item) => item.id === mailboxId) ?? mailboxes[0] ?? null;
	const setSelectedMailbox = useCallback(
		(item: MailboxOption | null) => {
			if (!item) return;
			setMailboxId(item.id);
			client.setQueryData(mailboxesQuery(scopeId).queryKey, (current) =>
				current?.map((row) =>
					row.id === item.id
						? {
								...row,
								display_name: item.displayName,
								signature: item.signature ?? row.signature,
							}
						: row,
				),
			);
		},
		[
			client,
			scopeId,
			setMailboxId,
			mailboxId,
			router,
			location.pathname,
			location.searchStr,
		],
	);
	return {
		mailboxes,
		selectedMailbox,
		setSelectedMailbox,
		isLoading: mailboxesLoading,
	};
}
