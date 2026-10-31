import { useQuery } from "@tanstack/react-query";
import { MailSessionProvider } from "@/components/mail-session-provider";
import { MailClientSync } from "@/components/mail-client-sync";
import { MailboxSelector } from "@/components/mailbox-selector";
import { mailboxesQuery, sessionQuery } from "@/queries";
import type { HomeAccountMenuProps } from "./types";

export function HomeAccountMenu({ user }: HomeAccountMenuProps) {
	const { data: session } = useQuery(sessionQuery());
	const { data: mailboxes } = useQuery({
		...mailboxesQuery(user.id),
		enabled: session?.user?.id === user.id,
	});
	if (!mailboxes || session?.user?.id !== user.id) return null;
	return (
		<MailSessionProvider
			key={user.id}
			user={session.user}
			mailboxes={mailboxes}
		>
			<MailClientSync timeZone={session.timeZone} />
			<MailboxSelector initialUser={user} />
		</MailSessionProvider>
	);
}
