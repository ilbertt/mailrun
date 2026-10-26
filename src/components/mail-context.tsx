import { createContext, useContext } from "react";
import type { User } from "../shared/contracts";
import type { mailboxesFn } from "../functions";
export type Mailbox = Awaited<ReturnType<typeof mailboxesFn>>[number];
export const MailContext = createContext<{
	user: User;
	mailboxes: Mailbox[];
	mailboxId: string;
	setMailboxId: (value: string) => void;
} | null>(null);
export function useMail() {
	const value = useContext(MailContext);
	if (!value) throw new Error("Mail context missing");
	return value;
}
