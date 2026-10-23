import { createContext, useContext } from "react";
import type { User } from "../shared/contracts";
import type { mailboxesFn } from "../functions";
import type { z } from "zod";
import type { draftSchema } from "../shared/mail-contracts";
export type ComposeIntent = {
	draftId?: string;
	initial?: Partial<z.infer<typeof draftSchema>>;
};
export type Mailbox = Awaited<ReturnType<typeof mailboxesFn>>[number];
export const MailContext = createContext<{
	user: User;
	mailboxes: Mailbox[];
	mailboxId: string;
	setMailboxId: (value: string) => void;
	openComposer: (intent?: ComposeIntent) => void;
} | null>(null);
export function useMail() {
	const value = useContext(MailContext);
	if (!value) throw new Error("Mail context missing");
	return value;
}
