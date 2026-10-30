import { useEffect, useState, type ReactNode } from "react";
import { useSearch } from "@tanstack/react-router";
import { MailContext, type Mailbox } from "./mail-context";
import type { User } from "../shared/contracts";

export function MailSessionProvider({
	user,
	mailboxes,
	children,
	scopeId = user?.id ?? "unverified",
	mailboxesLoading = false,
}: {
	user: User | null;
	scopeId?: string;
	mailboxesLoading?: boolean;
	mailboxes: Mailbox[];
	children: ReactNode;
}) {
	const search = useSearch({ strict: false });
	const [selected, setSelected] = useState("");
	const requested = search.mailboxId || selected;
	const primary = mailboxes.find((mailbox) => mailbox.isPrimary);
	const mailboxId = mailboxes.some((mailbox) => mailbox.id === requested)
		? requested
		: (primary?.id ?? mailboxes[0]?.id ?? "");
	useEffect(() => {
		try {
			const stored = localStorage.getItem("selected-mailbox-id");
			if (mailboxes.some((item) => item.id === stored))
				setSelected(stored ?? "");
		} catch {}
	}, [mailboxes]);
	const select = (value: string) => {
		setSelected(value);
		try {
			localStorage.setItem("selected-mailbox-id", value);
		} catch {}
	};
	return (
		<MailContext.Provider
			value={{
				user,
				scopeId,
				mailboxes,
				mailboxesLoading,
				mailboxId,
				setMailboxId: select,
			}}
		>
			{children}
		</MailContext.Provider>
	);
}
